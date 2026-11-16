import { describe, expect, test } from 'bun:test';
import { TmuxTerminal } from './tmux.ts';

describe('TmuxTerminal', () => {
  test('из окружения — только внутри tmux (TMUX_PANE)', () => {
    expect(TmuxTerminal.fromEnv({})).toBeUndefined();
    expect(TmuxTerminal.fromEnv({ TMUX_PANE: '%20' })).toBeInstanceOf(TmuxTerminal);
  });

  test('команда: очистить поле ввода (Ctrl+U), набрать буквально, Enter', async () => {
    const calls: string[][] = [];
    const terminal = new TmuxTerminal('%20', async (args) => void calls.push(args));
    await terminal.send('/clear');
    expect(calls).toEqual([
      ['send-keys', '-t', '%20', 'C-u'],
      ['send-keys', '-t', '%20', '-l', '/clear'],
      ['send-keys', '-t', '%20', 'Enter'],
    ]);
  });

  test('tmux завершился с ошибкой — исключение с его stderr', async () => {
    const terminal = new TmuxTerminal('%999', TmuxTerminal.run);
    await expect(terminal.send('/clear')).rejects.toThrow(/tmux/);
  });
});
