import { describe, expect, test } from 'bun:test';
import { ClaudeLaunch } from './launch.ts';

const FLAG = '--dangerously-load-development-channels';
const herald = new ClaudeLaunch('herald');

describe('ClaudeLaunch.parse — принимает ли Claude Code события канала', () => {
  test('флаг с server:herald — события принимаются', () => {
    expect(herald.parse(['claude', FLAG, 'server:herald'])).toEqual({ events: true, print: false });
    expect(herald.parse(['claude', `${FLAG}=server:herald`]).events).toBe(true);
  });

  test('несколько каналов: через пробел или запятую', () => {
    expect(herald.parse(['claude', FLAG, 'server:other', 'server:herald', '--resume']).events).toBe(true);
    expect(herald.parse(['claude', FLAG, 'server:other,server:herald']).events).toBe(true);
  });

  test('без флага, другой сервер, значение после следующего флага — событий нет', () => {
    expect(herald.parse(['claude', '--resume', 'abc', '--permission-mode', 'auto']).events).toBe(false);
    expect(herald.parse(['claude', FLAG, 'server:other']).events).toBe(false);
    expect(herald.parse(['claude', FLAG, '--resume', 'server:herald']).events).toBe(false);
  });

  test('--channels server:… — несогласованный сервер Claude Code отбрасывает', () => {
    expect(herald.parse(['claude', '--channels', 'server:herald']).events).toBe(false);
  });

  test('имя сервера — своё', () => {
    expect(new ClaudeLaunch('tg').parse(['claude', FLAG, 'server:tg']).events).toBe(true);
  });

  test('-p / --print — разовый запуск', () => {
    expect(herald.parse(['claude', '-p', 'привет']).print).toBe(true);
    expect(herald.parse(['claude', '--print', 'привет']).print).toBe(true);
  });
});

describe('ClaudeLaunch.of — аргументы родителя', () => {
  test('/proc/<pid>/cmdline: аргументы через \\0', async () => {
    const launch = await new ClaudeLaunch('herald', {
      readFile: async (path) => {
        expect(path).toBe('/proc/42/cmdline');
        return `claude\0${FLAG}\0server:herald\0`;
      },
      ps: async () => {
        throw new Error('не должен вызываться');
      },
    }).of(42);
    expect(launch).toEqual({ events: true, print: false });
  });

  test('нет /proc (macOS) — ps; нигде не вышло — undefined', async () => {
    const viaPs = await new ClaudeLaunch('herald', {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      ps: async (pid) => `claude -p ${pid}\n`,
    }).of(42);
    expect(viaPs).toEqual({ events: false, print: true });

    const none = await new ClaudeLaunch('herald', {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      ps: async () => {
        throw new Error('ps: нет такого процесса');
      },
    }).of(42);
    expect(none).toBeUndefined();
  });

  test('HERALD_CHANNEL_EVENTS=1|0 — поверх аргументов; иное значение не учитывается', async () => {
    const launch = new ClaudeLaunch('herald', {
      readFile: async () => 'claude\0-p\0',
      ps: async () => '',
    });
    expect(await launch.of(42, { HERALD_CHANNEL_EVENTS: '1' })).toEqual({ events: true, print: true });
    expect(await launch.of(42, { HERALD_CHANNEL_EVENTS: '0' })).toEqual({ events: false, print: true });
    expect(await launch.of(42, { HERALD_CHANNEL_EVENTS: 'да' })).toEqual({ events: false, print: true });
    const unreadable = new ClaudeLaunch('herald', {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      ps: async () => {
        throw new Error('нет ps');
      },
    });
    expect(await unreadable.of(42, { HERALD_CHANNEL_EVENTS: '1' })).toEqual({ events: true, print: false });
  });
});
