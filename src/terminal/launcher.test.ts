import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../app/ports.ts';
import { AgentLauncher, LaunchError } from './launcher.ts';

class RunningClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

const TRUST = ' Quick safety check\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm';
const DEV = '  WARNING: Loading development channels\n  ❯ 1. I am using this for local development\n    2. Exit';
const READY = '▎ Channels (experimental) messages from server:herald inject directly\n❯ задача';

/** tmux по сценарию: есть ли сессия, какие экраны показывает панель (последний повторяется). */
class FakeTmux {
  readonly calls: string[][] = [];
  constructor(
    private readonly sessionExists: boolean,
    private readonly screens: (string | Error)[],
  ) {}
  run = async (args: string[]): Promise<string | undefined> => {
    this.calls.push(args);
    const [command] = args;
    if (command === 'has-session' && !this.sessionExists) throw new Error("tmux has-session: can't find session");
    if (command === 'new-window' || command === 'new-session') return '%42 @7\n';
    if (command === 'capture-pane') {
      const screen = this.screens.length > 1 ? this.screens.shift() : this.screens[0];
      if (screen instanceof Error) throw screen;
      return screen;
    }
    return '';
  };
  keys(): string[][] {
    return this.calls.filter((c) => c[0] === 'send-keys').map((c) => c.slice(3));
  }
}

describe('AgentLauncher', () => {
  let home: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'herald-home-')));
    mkdirSync(join(home, 'dev', 'u7-hub'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const launcher = (tmux: FakeTmux, cwd = home) =>
    new AgentLauncher({ tmux: tmux.run, home, cwd, claude: '/bin/claude', clock: new RunningClock() });

  test('каталог: ~/…, относительный от текущего, абсолютный — внутри домашнего', () => {
    const l = launcher(new FakeTmux(true, [READY]), join(home, 'dev'));
    const hub = join(home, 'dev', 'u7-hub');
    expect(l.resolve('~/dev/u7-hub')).toBe(hub);
    expect(l.resolve('u7-hub')).toBe(hub);
    expect(l.resolve(hub)).toBe(hub);
    expect(l.resolve('~')).toBe(home);
  });

  test('каталог вне домашнего, несуществующий, файл, ссылка наружу — ошибка', () => {
    const l = launcher(new FakeTmux(true, [READY]));
    writeFileSync(join(home, 'файл'), '');
    symlinkSync(tmpdir(), join(home, 'наружу'));
    for (const dir of ['/etc', '~/нет', '~/файл', '~/наружу', '~/../'])
      expect(() => l.resolve(dir)).toThrow(LaunchError);
  });

  test('сессии agents нет — new-session; claude с каналом без shell, задача — после --', async () => {
    const tmux = new FakeTmux(false, [READY]);
    const launched = await launcher(tmux).launch({
      dir: '~/dev/u7-hub',
      prompt: '-x задача',
      tmuxSession: 'agents',
      timeoutMs: 10_000,
    });
    expect(launched).toEqual({ pane: '%42', window: '@7', dir: join(home, 'dev', 'u7-hub') });
    const create = tmux.calls.find((c) => c[0] === 'new-session');
    expect(create).toEqual([
      'new-session',
      '-d',
      '-P',
      '-F',
      '#{pane_id} #{window_id}',
      '-s',
      'agents',
      '-n',
      'u7-hub',
      '-c',
      join(home, 'dev', 'u7-hub'),
      '--',
      '/bin/claude',
      '--dangerously-load-development-channels',
      'server:herald',
      '--',
      '-x задача',
    ]);
  });

  test('сессия есть — new-window в ней; без задачи — без --', async () => {
    const tmux = new FakeTmux(true, [READY]);
    await launcher(tmux).launch({ dir: '~/dev/u7-hub', tmuxSession: 'agents', timeoutMs: 10_000 });
    const create = tmux.calls.find((c) => c[0] === 'new-window');
    expect(create?.slice(0, 7)).toEqual(['new-window', '-d', '-P', '-F', '#{pane_id} #{window_id}', '-t', '=agents:']);
    expect(create?.slice(-3)).toEqual(['/bin/claude', '--dangerously-load-development-channels', 'server:herald']);
  });

  test('диалоги: доверие к папке — Down, Enter; dev-канал — Enter; по разу на диалог', async () => {
    const tmux = new FakeTmux(true, ['загрузка', TRUST, TRUST, DEV, DEV, READY]);
    await launcher(tmux).launch({ dir: '~/dev/u7-hub', tmuxSession: 'agents', timeoutMs: 10_000 });
    expect(tmux.keys()).toEqual([['Down', 'Enter'], ['Enter']]);
    expect(tmux.calls.filter((c) => c[0] === 'send-keys').every((c) => c[2] === '%42')).toBe(true);
  });

  test('не дождался готовности к сроку — ошибка с хвостом экрана', async () => {
    const tmux = new FakeTmux(true, ['что-то странное на экране']);
    const launch = launcher(tmux).launch({ dir: '~/dev/u7-hub', tmuxSession: 'agents', timeoutMs: 3_000 });
    await expect(launch).rejects.toThrow(/что-то странное/);
  });

  test('окно закрылось (claude вышел) — ошибка', async () => {
    const tmux = new FakeTmux(true, ['загрузка', new Error("tmux capture-pane: can't find pane")]);
    const launch = launcher(tmux).launch({ dir: '~/dev/u7-hub', tmuxSession: 'agents', timeoutMs: 10_000 });
    await expect(launch).rejects.toThrow(/закрылось/);
  });
});
