import { describe, expect, test } from 'bun:test';
import type { Clock } from '../app/ports.ts';
import { SelfReset, type SignalReader } from './reset.ts';
import type { HookEvent, HookSignal } from './signals.ts';
import type { Terminal } from './terminal.ts';

/** Часы, которые сами идут вперёд на время сна: ожидание без настоящих пауз. */
class RunningClock implements Clock {
  constructor(public t = 0) {}
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

/** Окно агента: что набрано и когда; хуки «срабатывают» по сценарию от момента набора. */
class FakeWindow implements Terminal, SignalReader {
  readonly typed: { text: string; at: number }[] = [];
  private readonly signals: HookSignal[] = [];
  /** Через сколько мс после набора команды приходит SessionStart (и с каким source). */
  constructor(
    private readonly clock: RunningClock,
    private readonly after: Record<string, { ms: number; source: string } | undefined> = {},
    stopAt?: number,
  ) {
    if (stopAt !== undefined) this.signals.push({ event: 'Stop', at: stopAt });
  }
  async send(text: string): Promise<void> {
    this.typed.push({ text, at: this.clock.now() });
    const reaction = this.after[text];
    if (reaction)
      this.signals.push({ event: 'SessionStart', source: reaction.source, at: this.clock.now() + reaction.ms });
  }
  last(_pane: string, event: HookEvent, since: number): HookSignal | undefined {
    const seen = this.signals.filter((s) => s.event === event && s.at >= since && s.at <= this.clock.now());
    return seen[seen.length - 1];
  }
  /** Когда набран i-й текст. */
  at(i: number): number {
    const typed = this.typed[i];
    if (!typed) throw new Error(`набрано ${this.typed.length}, нет №${i}`);
    return typed.at;
  }
}

function setup(options: { stopAt?: number; after?: FakeWindow['after']; failSend?: boolean } = {}) {
  const clock = new RunningClock(1_000);
  const window = new FakeWindow(clock, options.after, options.stopAt);
  const notices: string[] = [];
  const terminal: Terminal = options.failSend
    ? {
        send: async () => {
          throw new Error("tmux send-keys: can't find pane");
        },
      }
    : window;
  const reset = new SelfReset({
    pane: '%20',
    terminal,
    signals: window,
    clock,
    notify: async (text) => void notices.push(text),
  });
  return { clock, window, notices, reset };
}

describe('SelfReset', () => {
  test('/clear: ждёт конца хода (Stop), набирает команду, ждёт SessionStart(clear), через паузу — сообщение', async () => {
    const { window, notices, reset } = setup({ stopAt: 5_000, after: { '/clear': { ms: 2_000, source: 'clear' } } });
    const outcome = await reset.run({ command: '/clear', message: 'Продолжай трек', timeoutMs: 60_000 });
    expect(outcome).toEqual({ ok: true });
    expect(window.typed.map((t) => t.text)).toEqual(['/clear', 'Продолжай трек']);
    const [command, message] = [window.at(0), window.at(1)];
    expect(command).toBeGreaterThanOrEqual(5_000);
    expect(message).toBeGreaterThanOrEqual(command + 2_000 + SelfReset.SETTLE_MS);
    expect(notices).toEqual([]);
  });

  test('/compact с указаниями: ждёт SessionStart(compact); SessionStart с другим source не считается', async () => {
    const { window, reset } = setup({
      stopAt: 1_000,
      after: { '/compact оставь план фазы': { ms: 30_000, source: 'compact' } },
    });
    await reset.run({ command: '/compact оставь план фазы', message: 'Дальше', timeoutMs: 60_000 });
    const [command, message] = [window.at(0), window.at(1)];
    expect(message - command).toBeGreaterThanOrEqual(30_000);

    const other = setup({ stopAt: 1_000, after: { '/clear': { ms: 100, source: 'startup' } } });
    const outcome = await other.reset.run({ command: '/clear', message: 'Дальше', timeoutMs: 5_000 });
    expect(outcome.ok).toBe(false);
    expect(other.window.typed.map((t) => t.text)).toEqual(['/clear']);
  });

  test('Stop раньше запуска (прошлый ход) не считается', async () => {
    const { window, reset } = setup({ stopAt: 999 });
    const outcome = await reset.run({ command: '/clear', timeoutMs: 3_000 });
    expect(outcome.ok).toBe(false);
    expect(window.typed).toEqual([]);
  });

  test('без сообщения — только команда; прочая команда — сообщение через паузу, без SessionStart', async () => {
    const plain = setup({ stopAt: 2_000, after: { '/clear': { ms: 100, source: 'clear' } } });
    expect(await plain.reset.run({ command: '/clear', timeoutMs: 10_000 })).toEqual({ ok: true });
    expect(plain.window.typed.map((t) => t.text)).toEqual(['/clear']);

    const other = setup({ stopAt: 2_000 });
    expect(await other.reset.run({ command: '/model sonnet', message: 'Дальше', timeoutMs: 10_000 })).toEqual({
      ok: true,
    });
    const [command, message] = [other.window.at(0), other.window.at(1)];
    expect(message - command).toBeGreaterThanOrEqual(SelfReset.SETTLE_MS);
  });

  test('хода конец не пришёл к сроку — команда не набрана, человеку уходит причина и текст сообщения', async () => {
    const { window, notices, reset, clock } = setup();
    const outcome = await reset.run({ command: '/clear', message: 'Продолжай трек X', timeoutMs: 10_000 });
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('Stop') });
    expect(window.typed).toEqual([]);
    expect(clock.now()).toBeGreaterThanOrEqual(11_000);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('/clear');
    expect(notices[0]).toContain('Продолжай трек X');
  });

  test('сброс не завершился к сроку — сообщение не набрано, человеку причина про SessionStart', async () => {
    const { window, notices, reset } = setup({ stopAt: 1_000 });
    const outcome = await reset.run({ command: '/clear', message: 'Дальше', timeoutMs: 5_000 });
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('SessionStart') });
    expect(window.typed.map((t) => t.text)).toEqual(['/clear']);
    expect(notices[0]).toContain('Дальше');
  });

  test('--delay: команда сразу, сообщение через заданное время, хуки не нужны', async () => {
    const { window, reset } = setup();
    expect(await reset.run({ command: '/new', message: 'Дальше', timeoutMs: 1_000, delayMs: 3_000 })).toEqual({
      ok: true,
    });
    const [command, message] = [window.at(0), window.at(1)];
    expect(command).toBe(1_000);
    expect(message - command).toBe(3_000);
  });

  test('tmux не набрал — человеку причина; сбой уведомления не роняет', async () => {
    const { notices, reset } = setup({ stopAt: 1_000, failSend: true });
    const outcome = await reset.run({ command: '/clear', timeoutMs: 5_000 });
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("can't find pane") });
    expect(notices[0]).toContain("can't find pane");

    const broken = new SelfReset({
      pane: '%20',
      terminal: { send: async () => {} },
      signals: { last: () => undefined },
      clock: new RunningClock(),
      notify: async () => {
        throw new Error('сервер недоступен');
      },
    });
    expect((await broken.run({ command: '/clear', timeoutMs: 1_000 })).ok).toBe(false);
  });
});
