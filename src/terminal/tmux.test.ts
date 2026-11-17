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

  test('многострочный текст — вставкой из буфера (bracketed paste), затем Enter: перевод строки не отправляет раньше', async () => {
    const calls: string[][] = [];
    const terminal = new TmuxTerminal('%20', async (args) => void calls.push(args));
    await terminal.send('Продолжай трек.\nФаза 2, задача 1.');
    expect(calls).toEqual([
      ['send-keys', '-t', '%20', 'C-u'],
      ['set-buffer', '-b', 'herald-%20', '--', 'Продолжай трек.\nФаза 2, задача 1.'],
      ['paste-buffer', '-p', '-d', '-b', 'herald-%20', '-t', '%20'],
      ['send-keys', '-t', '%20', 'Enter'],
    ]);
  });

  test('панель — из конструктора', () => {
    expect(new TmuxTerminal('%7').pane).toBe('%7');
  });

  test('экран панели — capture-pane, текст как есть', async () => {
    const calls: string[][] = [];
    const terminal = new TmuxTerminal('%20', async (args) => {
      calls.push(args);
      return 'строка 1\nстрока 2\n';
    });
    expect(await terminal.screen()).toBe('строка 1\nстрока 2\n');
    expect(calls).toEqual([['capture-pane', '-p', '-t', '%20']]);
  });

  test('клавиши — как есть, без очистки поля ввода', async () => {
    const calls: string[][] = [];
    const terminal = new TmuxTerminal('%20', async (args) => void calls.push(args));
    await terminal.press('Down', 'Enter');
    expect(calls).toEqual([['send-keys', '-t', '%20', 'Down', 'Enter']]);
  });

  test('tmux run возвращает stdout', async () => {
    expect(await TmuxTerminal.run(['-V'])).toMatch(/^tmux /);
  });

  test('tmux завершился с ошибкой — исключение с его stderr', async () => {
    const terminal = new TmuxTerminal('%999', TmuxTerminal.run);
    await expect(terminal.send('/clear')).rejects.toThrow(/tmux/);
  });
});
