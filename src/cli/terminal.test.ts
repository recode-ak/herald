import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemClock } from '../infra/system.ts';
import { HookSignals } from '../terminal/signals.ts';
import { Cli } from './cli.ts';

describe('herald hook', () => {
  let state: string;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'herald-state-'));
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  const run = async (stdin: string, env: Record<string, string> = {}) => {
    let stdout = '';
    let stderr = '';
    const code = await new Cli({
      env: { XDG_STATE_HOME: state, ...env },
      cwd: state,
      clock: new SystemClock(),
      out: (s) => {
        stdout += s;
      },
      err: (s) => {
        stderr += s;
      },
      stdin: async () => stdin,
    }).run(['hook']);
    return { code, stdout, stderr };
  };
  const signals = () => new HookSignals(HookSignals.dirOf({ XDG_STATE_HOME: state }));

  test('SessionStart в tmux — метка панели с source; stdout пуст, код 0', async () => {
    const before = Date.now();
    const result = await run('{"hook_event_name":"SessionStart","source":"clear"}', { TMUX_PANE: '%20' });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(signals().last('%20', 'SessionStart', before)?.source).toBe('clear');
  });

  test('Stop в tmux — метка конца хода', async () => {
    const before = Date.now();
    await run('{"hook_event_name":"Stop"}', { TMUX_PANE: '%20' });
    expect(signals().last('%20', 'Stop', before)).toBeDefined();
  });

  test('вне tmux, чужое событие, битый JSON — ничего не пишет, код 0', async () => {
    expect((await run('{"hook_event_name":"Stop"}')).code).toBe(0);
    expect((await run('{"hook_event_name":"PreToolUse"}', { TMUX_PANE: '%20' })).code).toBe(0);
    expect((await run('}{', { TMUX_PANE: '%20' })).code).toBe(0);
    expect(readdirSync(state)).toEqual([]);
  });

  test('записать не удалось — причина в stderr, но код 0: хук не мешает окну', async () => {
    const result = await run('{"hook_event_name":"Stop"}', { TMUX_PANE: '%20', XDG_STATE_HOME: '/proc/нельзя' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('herald hook');
  });
});

describe('herald self', () => {
  let state: string;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'herald-state-'));
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  const run = async (args: string[], env: Record<string, string> = { TMUX_PANE: '%20' }) => {
    let stdout = '';
    let stderr = '';
    const detached: { argv: string[]; log: string }[] = [];
    const typed: { pane: string; text: string }[] = [];
    const code = await new Cli({
      env: { XDG_STATE_HOME: state, HERALD_CONFIG: join(state, 'нет.json'), ...env },
      cwd: state,
      clock: new SystemClock(),
      out: (s) => {
        stdout += s;
      },
      err: (s) => {
        stderr += s;
      },
      detach: async (argv, log) => void detached.push({ argv, log }),
      terminal: (pane) => ({ send: async (text) => void typed.push({ pane, text }) }),
    }).run(['self', ...args]);
    return { code, stdout, stderr, detached, typed };
  };

  test('запускает себя фоном с теми же параметрами и сразу отвечает: панель и лог', async () => {
    const result = await run(['/compact', 'оставь', 'план', '--message', 'Продолжай трек', '--timeout', '30']);
    expect(result.code).toBe(0);
    const log = join(state, 'herald', 'self', '20.log');
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, pane: '%20', log });
    expect(result.detached).toEqual([
      {
        argv: ['self', '--foreground', '--timeout', '30', '--message', 'Продолжай трек', '--', '/compact оставь план'],
        log,
      },
    ]);
    expect(result.typed).toEqual([]);
  });

  test('--delay передаётся фоновому процессу; срок по умолчанию — 600 с', async () => {
    const result = await run(['/new', '--delay', '3']);
    expect(result.detached[0]?.argv).toEqual([
      'self',
      '--foreground',
      '--timeout',
      '600',
      '--delay',
      '3',
      '--',
      '/new',
    ]);
  });

  test('--foreground: выполняет сам — набирает в свою панель', async () => {
    const result = await run(['--foreground', '--delay', '0', '--message', 'Дальше', '--', '/clear']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(result.typed).toEqual([
      { pane: '%20', text: '/clear' },
      { pane: '%20', text: 'Дальше' },
    ]);
  });

  test('--foreground: не дождался хука — код 1 и причина', async () => {
    const result = await run(['--foreground', '--timeout', '0', '/clear']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, reason: expect.stringContaining('Stop') });
    expect(result.typed).toEqual([]);
  });

  test('вне tmux — ошибка сразу, фоном не запускается', async () => {
    const result = await run(['/clear'], {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('tmux');
    expect(result.detached).toEqual([]);
  });

  test('команда — обязательна и с «/», в одну строку', async () => {
    for (const args of [[], ['clear'], ['/clear\nещё']]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.detached).toEqual([]);
    }
  });
});

describe('herald spawn', () => {
  let home: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'herald-home-')));
    mkdirSync(join(home, 'dev', 'u7-hub'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = async (args: string[], claude: string | null = '/bin/claude') => {
    let stdout = '';
    let stderr = '';
    const calls: string[][] = [];
    const code = await new Cli({
      env: { HOME: home },
      cwd: home,
      clock: new SystemClock(),
      out: (s) => {
        stdout += s;
      },
      err: (s) => {
        stderr += s;
      },
      tmux: async (a) => {
        calls.push(a);
        if (a[0] === 'new-session' || a[0] === 'new-window') return '%42 @7';
        if (a[0] === 'capture-pane') return '▎ Channels (experimental) messages';
        return '';
      },
      claude: () => claude ?? undefined,
    }).run(['spawn', ...args]);
    return { code, stdout, stderr, calls };
  };

  test('окно в сессии agents с задачей; вывод — панель, окно, каталог', async () => {
    const result = await run(['~/dev/u7-hub', '--prompt', 'Сделай X']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      pane: '%42',
      window: '@7',
      dir: join(home, 'dev', 'u7-hub'),
    });
    const create = result.calls.find((c) => c[0] === 'new-window' || c[0] === 'new-session');
    expect(create).toContain('=agents:');
    expect(create?.slice(-2)).toEqual(['--', 'Сделай X']);
  });

  test('--tmux — другая сессия', async () => {
    const result = await run(['~/dev/u7-hub', '--tmux', 'work']);
    expect(result.calls.find((c) => c[0] === 'has-session')).toEqual(['has-session', '-t', '=work']);
  });

  test('каталог вне домашнего или без каталога — код 1, окно не открыто', async () => {
    for (const args of [['/etc'], []]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.calls.some((c) => c[0] === 'new-window' || c[0] === 'new-session')).toBe(false);
    }
  });

  test('claude не найден в PATH — код 1', async () => {
    const result = await run(['~/dev/u7-hub'], null);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('claude');
  });
});
