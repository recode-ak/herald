import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
