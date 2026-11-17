import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from '../app/agent.ts';
import { HostService } from '../app/host.ts';
import { FakeTelegram } from '../app/telegram.fake.ts';
import { ManualClock, NUR_CHAT, SeqIds } from '../app/testkit.fake.ts';
import { Waiter } from '../app/waiter.ts';
import { HeraldClientError, type LaunchOutcome } from '../client/client.ts';
import { Access } from '../domain/access.ts';
import { Launch } from '../domain/host.ts';
import { HttpApi } from '../http/api.ts';
import type { LaunchWire } from '../http/wire.ts';
import { SqliteStore } from '../infra/sqlite-store.ts';
import { SystemClock } from '../infra/system.ts';
import { LaunchError, type Launched, type LaunchRequest } from '../terminal/launcher.ts';
import { Cli } from './cli.ts';
import { HostDaemon, type HostLink, type WindowLauncher } from './host.ts';

/** Сервер для демона: опросы отвечают из очереди (запуски или ошибка); пусто — опрос висит до новой записи. */
class FakeLink implements HostLink {
  readonly polls: (number | undefined)[] = [];
  readonly done: { id: string; outcome: LaunchOutcome }[] = [];
  /** Ошибки `hostDone` по очереди; кончились — успех. */
  readonly doneErrors: Error[] = [];
  private readonly queue: (LaunchWire[] | Error)[] = [];
  private waiting: (() => void) | undefined;

  push(...results: (LaunchWire[] | Error)[]): void {
    this.queue.push(...results);
    this.waiting?.();
  }

  async hostPoll(waitMs?: number): Promise<LaunchWire[]> {
    this.polls.push(waitMs);
    while (this.queue.length === 0) await new Promise<void>((r) => (this.waiting = r));
    const next = this.queue.shift() as LaunchWire[] | Error;
    if (next instanceof Error) throw next;
    return next;
  }

  async hostDone(id: string, outcome: LaunchOutcome): Promise<void> {
    const error = this.doneErrors.shift();
    if (error) throw error;
    this.done.push({ id, outcome });
  }
}

class FakeLauncher implements WindowLauncher {
  readonly requests: LaunchRequest[] = [];
  /** Итог по каталогу: окно или ошибка; нет — окно `@<n>`. */
  readonly results = new Map<string, Launched | Error>();
  /** Задержать запуски, пока не вызван `release`. */
  hold: Promise<void> | undefined;

  async launch(request: LaunchRequest): Promise<Launched> {
    this.requests.push(request);
    await this.hold;
    const result = this.results.get(request.dir);
    if (result instanceof Error) throw result;
    const n = this.requests.length;
    return result ?? { pane: `%${n}`, window: `@${n}`, dir: `/home/nur/${request.dir}` };
  }
}

const launch = (id: string, dir = 'dev/x', prompt = 'задача'): LaunchWire => ({ id, dir, prompt, createdAt: 1 });

function setup() {
  const link = new FakeLink();
  const launcher = new FakeLauncher();
  const clock = new ManualClock();
  const log: string[] = [];
  const stop = new AbortController();
  const daemon = new HostDaemon({
    link,
    launcher,
    clock,
    log: (line) => log.push(line),
    name: 'laptop',
    tmuxSession: 'agents',
    timeoutMs: 60_000,
    retryDelayMs: 2_000,
  });
  /** Дать циклу демона дойти до следующего ожидания. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Bun.sleep(0);
  };
  return { link, launcher, clock, log, stop, daemon, settle };
}

describe('HostDaemon (herald host)', () => {
  test('запуски — по одному: окно в tmux-сессии со сроком, итог на сервер; затем снова опрос', async () => {
    const k = setup();
    const running = k.daemon.run(k.stop.signal);
    k.link.push([launch('l_1', 'dev/a', 'тесты'), launch('l_2', 'dev/b', 'ревью')]);
    await k.settle();
    expect(k.launcher.requests).toEqual([
      { dir: 'dev/a', prompt: 'тесты', tmuxSession: 'agents', timeoutMs: 60_000 },
      { dir: 'dev/b', prompt: 'ревью', tmuxSession: 'agents', timeoutMs: 60_000 },
    ]);
    expect(k.link.done).toEqual([
      { id: 'l_1', outcome: { ok: true, text: '/home/nur/dev/a (окно @1, панель %1)' } },
      { id: 'l_2', outcome: { ok: true, text: '/home/nur/dev/b (окно @2, панель %2)' } },
    ]);
    expect(k.link.polls.length).toBe(2);
    expect(k.link.polls[0]).toBe(HostDaemon.POLL_MS);
    k.stop.abort();
    expect(await running).toBe(0);
    expect(k.log[0]).toContain('laptop');
    expect(k.log.some((l) => l.includes('l_1') && l.includes('dev/a'))).toBe(true);
  });

  test('запуск не удался — итог с причиной (и для чужой ошибки); демон работает дальше', async () => {
    const k = setup();
    k.launcher.results.set('нет', new LaunchError('нет каталога /home/nur/нет'));
    k.launcher.results.set('tmux', new Error('tmux: no server'));
    const running = k.daemon.run(k.stop.signal);
    k.link.push([launch('l_1', 'нет'), launch('l_2', 'tmux')], [launch('l_3')]);
    await k.settle();
    expect(k.link.done).toEqual([
      { id: 'l_1', outcome: { ok: false, text: 'нет каталога /home/nur/нет' } },
      { id: 'l_2', outcome: { ok: false, text: 'tmux: no server' } },
      { id: 'l_3', outcome: { ok: true, text: '/home/nur/dev/x (окно @3, панель %3)' } },
    ]);
    k.stop.abort();
    expect(await running).toBe(0);
    expect(k.log.some((l) => l.includes('l_1') && l.includes('нет каталога'))).toBe(true);
  });

  test('стоп во время опроса — сразу код 0', async () => {
    const k = setup();
    const running = k.daemon.run(k.stop.signal);
    await k.settle();
    k.stop.abort();
    expect(await running).toBe(0);
    expect(k.launcher.requests).toEqual([]);
  });

  test('стоп во время запуска — запуск доводится, итог уходит, нового опроса нет', async () => {
    const k = setup();
    let release = () => {};
    k.launcher.hold = new Promise((r) => (release = r));
    const running = k.daemon.run(k.stop.signal);
    k.link.push([launch('l_1'), launch('l_2')]);
    await k.settle();
    k.stop.abort();
    release();
    expect(await running).toBe(0);
    // Выданный запуск сервер больше не отдаст: доводим все взятые, а не теряем второй.
    expect(k.link.done.map((d) => d.id)).toEqual(['l_1', 'l_2']);
    expect(k.link.polls.length).toBe(1);
  });

  test('сервер недоступен или 5xx при опросе — в лог и снова опрос; иная ошибка (401) — код 1', async () => {
    const k = setup();
    const running = k.daemon.run(k.stop.signal);
    k.link.push(new HeraldClientError('сервер herald недоступен'), new HeraldClientError('Bad Gateway', 502));
    await k.settle();
    k.link.push([launch('l_1')]);
    await k.settle();
    expect(k.link.done.map((d) => d.id)).toEqual(['l_1']);
    expect(k.log.filter((l) => l.includes('недоступен') || l.includes('Bad Gateway')).length).toBe(2);
    k.link.push(new HeraldClientError('неверный токен', 401));
    expect(await running).toBe(1);
    expect(k.log.at(-1)).toContain('неверный токен');
  });

  test('итог: сервер недоступен — повтор через паузу; ответ с кодом (502, 400) — только в лог', async () => {
    const k = setup();
    k.link.doneErrors.push(new HeraldClientError('сервер herald недоступен'));
    const running = k.daemon.run(k.stop.signal);
    k.link.push([launch('l_1')]);
    await k.settle();
    expect(k.link.done).toEqual([]);
    k.clock.advance(2_000);
    await k.settle();
    expect(k.link.done.map((d) => d.id)).toEqual(['l_1']);

    k.link.doneErrors.push(new HeraldClientError('бот заблокирован', 502), new HeraldClientError('уже завершён', 400));
    k.link.push([launch('l_2'), launch('l_3')]);
    await k.settle();
    expect(k.link.done.map((d) => d.id)).toEqual(['l_1']);
    expect(k.log.some((l) => l.includes('l_2') && l.includes('бот заблокирован'))).toBe(true);
    expect(k.log.some((l) => l.includes('l_3') && l.includes('уже завершён'))).toBe(true);
    k.stop.abort();
    expect(await running).toBe(0);
  });

  test('итог: сервер недоступен дольше попыток — в лог, демон работает дальше', async () => {
    const k = setup();
    for (let i = 0; i < HostDaemon.DONE_ATTEMPTS; i++) k.link.doneErrors.push(new HeraldClientError('недоступен'));
    const running = k.daemon.run(k.stop.signal);
    k.link.push([launch('l_1')]);
    for (let i = 0; i < HostDaemon.DONE_ATTEMPTS; i++) {
      await k.settle();
      k.clock.advance(2_000);
    }
    await k.settle();
    expect(k.link.done).toEqual([]);
    expect(k.log.some((l) => l.includes('l_1') && l.includes('итог не доставлен'))).toBe(true);
    expect(k.link.polls.length).toBe(2);
    k.stop.abort();
    expect(await running).toBe(0);
  });
});

describe('herald host (CLI → HTTP → окно → итог в Telegram)', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  function setup() {
    const clock = new SystemClock();
    const telegram = new FakeTelegram();
    const deps = {
      store: SqliteStore.open(':memory:'),
      telegram,
      access: Access.parse('nur:t-nur', `nur:${NUR_CHAT}`),
      clock,
      ids: new SeqIds(),
      waiter: new Waiter(clock),
      timeZone: 'Asia/Oral',
    };
    const server = new HttpApi({
      agent: new AgentService(deps),
      host: new HostService(deps),
      access: deps.access,
      maxWaitMs: 40,
    }).listen({ port: 0, hostname: '127.0.0.1' });
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'herald-home-')));
    mkdirSync(join(home, 'dev', 'u7-hub'), { recursive: true });
    cleanup.push(
      () => server.stop(true),
      () => rmSync(home, { recursive: true, force: true }),
    );
    const stop = new AbortController();
    const tmux: string[][] = [];
    let stderr = '';
    const run = (args: string[], claude: string | null = '/bin/claude') =>
      new Cli({
        env: {
          HOME: home,
          HERALD_CONFIG: join(home, 'нет.json'),
          HERALD_URL: `http://127.0.0.1:${server.port}`,
          HERALD_TOKEN: 't-nur',
          HERALD_HOST: 'laptop',
        },
        cwd: '/',
        clock,
        out: () => {},
        err: (s) => {
          stderr += s;
        },
        tmux: async (a) => {
          tmux.push(a);
          if (a[0] === 'new-session' || a[0] === 'new-window') return '%42 @7';
          if (a[0] === 'capture-pane') return '▎ Channels (experimental) messages';
          return '';
        },
        claude: () => claude ?? undefined,
        stop: () => stop.signal,
      }).run(['host', ...args]);
    const launch = (id: string, dir: string) => {
      deps.store.saveLaunch(
        Launch.create(
          { id, person: 'nur', host: 'laptop', dir, prompt: 'Сделай X', chatId: NUR_CHAT, messageId: 7 },
          clock.now(),
        ),
      );
      deps.waiter.notify(Waiter.hostTopic('nur', 'laptop'));
    };
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(10);
    };
    return { home, telegram, stop, tmux, run, launch, until, stderr: () => stderr };
  }

  test('каталог от ~ — окно в сессии agents с задачей; человеку reply с итогом; SIGTERM — код 0', async () => {
    const k = setup();
    const running = k.run([]);
    k.launch('l_1', 'dev/u7-hub');
    await k.until(() => k.telegram.last(NUR_CHAT) !== undefined);
    expect(k.telegram.last(NUR_CHAT)).toMatchObject({
      text: `🪟 Окно открыто на laptop: ${join(k.home, 'dev', 'u7-hub')} (окно @7, панель %42)`,
      replyTo: 7,
    });
    const create = k.tmux.find((c) => c[0] === 'new-window' || c[0] === 'new-session');
    expect(create).toContain('=agents:');
    expect(create?.slice(-2)).toEqual(['--', 'Сделай X']);

    k.launch('l_2', 'нет');
    await k.until(() => k.telegram.last(NUR_CHAT)?.text.startsWith('⚠️') ?? false);
    expect(k.telegram.last(NUR_CHAT)?.text).toBe(`⚠️ Окно не открылось на laptop: нет каталога ${join(k.home, 'нет')}`);
    k.stop.abort();
    expect(await running).toBe(0);
    expect(k.stderr()).toContain('herald host: машина laptop');
  });

  test('--tmux — другая сессия', async () => {
    const k = setup();
    const running = k.run(['--tmux', 'work', '--timeout', '5']);
    k.launch('l_1', 'dev/u7-hub');
    await k.until(() => k.telegram.last(NUR_CHAT) !== undefined);
    expect(k.tmux.find((c) => c[0] === 'has-session')).toEqual(['has-session', '-t', '=work']);
    k.stop.abort();
    expect(await running).toBe(0);
  });

  test('claude не найден, лишние аргументы — код 1 сразу', async () => {
    const k = setup();
    expect(await k.run([], null)).toBe(1);
    expect(k.stderr()).toContain('claude');
    expect(await k.run(['dev'])).toBe(1);
  });
});
