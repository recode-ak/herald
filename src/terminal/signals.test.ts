import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookSignals } from './signals.ts';

describe('HookSignals', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'herald-hooks-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('каталог — $XDG_STATE_HOME/herald/hooks, иначе ~/.local/state/herald/hooks', () => {
    expect(HookSignals.dirOf({ XDG_STATE_HOME: '/s', HOME: '/h' })).toBe('/s/herald/hooks');
    expect(HookSignals.dirOf({ HOME: '/h' })).toBe('/h/.local/state/herald/hooks');
  });

  test('разбор stdin хука: Stop и SessionStart с source; прочее и битый JSON — нет сигнала', () => {
    expect(HookSignals.parse('{"hook_event_name":"Stop","session_id":"x"}', 100)).toEqual({ event: 'Stop', at: 100 });
    expect(HookSignals.parse('{"hook_event_name":"SessionStart","source":"clear"}', 100)).toEqual({
      event: 'SessionStart',
      source: 'clear',
      at: 100,
    });
    expect(HookSignals.parse('{"hook_event_name":"PreToolUse"}', 100)).toBeUndefined();
    expect(HookSignals.parse('не json', 100)).toBeUndefined();
    expect(HookSignals.parse('[]', 100)).toBeUndefined();
  });

  test('записанный сигнал читается по панели и событию, если он не раньше заданного момента', () => {
    const signals = new HookSignals(dir);
    signals.record('%20', { event: 'SessionStart', source: 'clear', at: 1_000 });
    expect(signals.last('%20', 'SessionStart', 1_000)).toEqual({ event: 'SessionStart', source: 'clear', at: 1_000 });
    expect(signals.last('%20', 'SessionStart', 1_001)).toBeUndefined();
    expect(signals.last('%20', 'Stop', 0)).toBeUndefined();
    expect(signals.last('%21', 'SessionStart', 0)).toBeUndefined();
  });

  test('новый сигнал того же события заменяет прежний; имя файла — без «%»', () => {
    const signals = new HookSignals(dir);
    signals.record('%20', { event: 'Stop', at: 1 });
    signals.record('%20', { event: 'Stop', at: 2 });
    expect(signals.last('%20', 'Stop', 0)?.at).toBe(2);
    expect(readdirSync(dir)).toEqual(['20.Stop.json']);
  });

  test('каталога ещё нет — запись создаёт его, чтение — нет сигнала', () => {
    const signals = new HookSignals(join(dir, 'a', 'b'));
    expect(signals.last('%20', 'Stop', 0)).toBeUndefined();
    signals.record('%20', { event: 'Stop', at: 5 });
    expect(signals.last('%20', 'Stop', 0)?.at).toBe(5);
  });
});
