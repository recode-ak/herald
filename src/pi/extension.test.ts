import { afterEach, describe, expect, test } from 'bun:test';
import { FakeHerald } from '../channel/herald.fake.ts';
import {
  HeraldExtension,
  type PiApi,
  type PiCommand,
  type PiCommandContext,
  type PiContext,
  type PiEvent,
  type PiSendOptions,
} from './extension.ts';

type Handler = (event: PiEvent, ctx: PiContext) => unknown;

/** pi в памяти: подписки, команды, отправленные сообщения; контекст команды — управляемый. */
class FakePi implements PiApi {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, PiCommand>();
  readonly sent: { text: string; options?: PiSendOptions }[] = [];
  readonly notices: string[] = [];
  readonly compactions: Parameters<PiCommandContext['compact']>[0][] = [];
  newSessions = 0;
  newSessionCancelled = false;
  idle: Promise<void> = Promise.resolve();

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(name: string, command: PiCommand): void {
    this.commands.set(name, command);
  }

  sendUserMessage(text: string, options?: PiSendOptions): void {
    this.sent.push(options ? { text, options } : { text });
    // Как pi: команда расширения с expandPromptTemplates выполняется сразу.
    if (options?.expandPromptTemplates && text.startsWith('/')) {
      void this.commands.get(text.slice(1))?.handler('', this.commandContext());
    }
  }

  async emit(event: string, payload: PiEvent, ctx: PiContext = this.context()): Promise<void> {
    for (const h of this.handlers.get(event) ?? []) await h(payload, ctx);
  }

  context(mode: PiContext['mode'] = 'tui', sessionId = '019a7c3e-55aa'): PiContext {
    return {
      mode,
      cwd: '/home/nur/dev/x',
      ui: { notify: (m) => this.notices.push(m) },
      sessionManager: { getSessionId: () => sessionId },
    };
  }

  commandContext(): PiCommandContext {
    return {
      ...this.context(),
      waitForIdle: () => this.idle,
      newSession: async () => {
        this.newSessions++;
        return { cancelled: this.newSessionCancelled };
      },
      compact: (options) => {
        this.compactions.push(options);
      },
    };
  }
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function setup(options: { configError?: string } = {}) {
  const pi = new FakePi();
  const herald = new FakeHerald();
  const connected: { cwd: string; sessionId: string }[] = [];
  new HeraldExtension(pi, {
    connect: (where) => {
      if (options.configError) throw new Error(options.configError);
      connected.push(where);
      return herald;
    },
    bridge: { retryDelayMs: 5 },
  }).register();
  cleanup.push(() => pi.emit('session_shutdown', { reason: 'quit' }));
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(5);
    expect(cond()).toBe(true);
  };
  return { pi, herald, connected, until };
}

describe('HeraldExtension — сессия', () => {
  test('команды herald-clear и herald-compact', () => {
    const { pi } = setup();
    expect([...pi.commands.keys()].sort()).toEqual(['herald-clear', 'herald-compact']);
  });

  test('session_start в TUI — клиент сессии pi (каталог, id сессии), цикл входящих', async () => {
    const { pi, herald, connected, until } = setup();
    await pi.emit('session_start', { reason: 'startup' });
    expect(connected).toEqual([{ cwd: '/home/nur/dev/x', sessionId: '019a7c3e-55aa' }]);
    await until(() => herald.polls > 0);
  });

  test('pi -p (print, json) — расширение молчит: иначе выжимка chronicle дала бы лишнюю сессию', async () => {
    const { pi, connected } = setup();
    await pi.emit('session_start', { reason: 'startup' }, pi.context('print'));
    await pi.emit('session_start', { reason: 'startup' }, pi.context('json'));
    expect(connected).toEqual([]);
  });

  test('нет настроек herald — предупреждение в pi, без цикла', async () => {
    const { pi, herald } = setup({ configError: 'serverUrl не задан' });
    await pi.emit('session_start', { reason: 'startup' });
    expect(pi.notices).toEqual(['herald отключён: serverUrl не задан']);
    expect(herald.polls).toBe(0);
  });

  test('session_shutdown — bye; при reload окно не закрывается', async () => {
    const quit = setup();
    await quit.pi.emit('session_start', { reason: 'startup' });
    await quit.pi.emit('session_shutdown', { reason: 'new' });
    expect(quit.herald.byes).toBe(1);

    const reload = setup();
    await reload.pi.emit('session_start', { reason: 'startup' });
    await reload.pi.emit('session_shutdown', { reason: 'reload' });
    expect(reload.herald.byes).toBe(0);
  });
});

describe('HeraldExtension — входящие', () => {
  test('указание → сообщение пользователя с deliverAs steer (агент занят — после текущих инструментов)', async () => {
    const { pi, herald, until } = setup();
    await pi.emit('session_start', { reason: 'startup' });
    herald.push({ id: 'i1', kind: 'directive', text: 'стоп', createdAt: 0 });
    await until(() => herald.acked.length === 1);
    expect(pi.sent).toHaveLength(1);
    expect(pi.sent[0]?.text).toStartWith('Указание человека из Telegram (herald): стоп');
    expect(pi.sent[0]?.options).toEqual({ deliverAs: 'steer' });
  });

  test('во время сжатия контекста pi не принимает сообщения — доставка ждёт конца сжатия', async () => {
    const { pi, herald, until } = setup();
    await pi.emit('session_start', { reason: 'startup' });
    await pi.emit('session_before_compact', {});
    herald.push({ id: 'i1', kind: 'directive', text: 'стоп', createdAt: 0 });
    await Bun.sleep(40);
    expect(pi.sent).toEqual([]);
    await pi.emit('session_compact_failed', {});
    await until(() => pi.sent.length === 1);
  });

  test('/clear → команда herald-clear: дождаться конца хода, новая сессия', async () => {
    const { pi, herald, until } = setup();
    let finishTurn = () => {};
    pi.idle = new Promise((resolve) => {
      finishTurn = resolve;
    });
    await pi.emit('session_start', { reason: 'startup' });
    herald.push({ id: 'i1', kind: 'command', text: '/clear', createdAt: 0 });
    await until(() => herald.acked.length === 1);
    expect(pi.sent).toEqual([{ text: '/herald-clear', options: { expandPromptTemplates: true } }]);
    expect(pi.newSessions).toBe(0);
    finishTurn();
    await until(() => pi.newSessions === 1);
  });

  test('новую сессию отменили — человеку уведомление', async () => {
    const { pi, herald, until } = setup();
    pi.newSessionCancelled = true;
    await pi.emit('session_start', { reason: 'startup' });
    herald.push({ id: 'i1', kind: 'command', text: '/clear', createdAt: 0 });
    await until(() => herald.notified.length === 1);
    expect(herald.notified).toEqual(['⚠️ /clear не выполнена: новую сессию отменило расширение pi']);
  });

  test('/compact → команда herald-compact: дождаться конца хода, сжатие; сбой — человеку', async () => {
    const { pi, herald, until } = setup();
    await pi.emit('session_start', { reason: 'startup' });
    herald.push({ id: 'i1', kind: 'command', text: '/compact', createdAt: 0 });
    await until(() => pi.compactions.length === 1);
    pi.compactions[0]?.onError?.(new Error('Nothing to compact (session too small)'));
    await until(() => herald.notified.length === 1);
    expect(herald.notified).toEqual(['⚠️ /compact не выполнена: Nothing to compact (session too small)']);
  });

  test('неизвестная команда — человеку уведомление', async () => {
    const { pi, herald, until } = setup();
    await pi.emit('session_start', { reason: 'startup' });
    herald.push({ id: 'i1', kind: 'command', text: '/model', createdAt: 0 });
    await until(() => herald.notified.length === 1);
    expect(herald.notified).toEqual(['⚠️ /model не выполнена: pi не знает этой команды']);
  });
});
