import { describe, expect, test } from 'bun:test';
import { ConfigError, ServerConfig } from './config.ts';

const required = { HERALD_TOKENS: 'nur:t-nur', HERALD_PEOPLE: 'nur:111', HERALD_BOT_TOKEN: '123:abc' };

describe('ServerConfig.fromEnv', () => {
  test('значения по умолчанию', () => {
    const config = ServerConfig.fromEnv(required);
    expect(config.port).toBe(4518);
    expect(config.hostname).toBe('127.0.0.1');
    expect(config.dbPath).toBe('./data/herald.db');
    expect(config.botToken).toBe('123:abc');
    expect(config.telegramApiUrl).toBe('https://api.telegram.org');
    expect(config.maxWaitMs).toBe(50_000);
    expect(config.access.personByToken('t-nur')).toBe('nur');
    expect(config.access.chatIdOf('nur')).toBe(111);
  });

  test('переопределения', () => {
    const config = ServerConfig.fromEnv({
      ...required,
      HERALD_PORT: '0',
      HERALD_HOSTNAME: '0.0.0.0',
      HERALD_DB: '/srv/herald/data/herald.db',
      HERALD_TELEGRAM_API: 'http://127.0.0.1:9999/',
      HERALD_MAX_WAIT_SECONDS: '25',
    });
    expect(config).toMatchObject({
      port: 0,
      hostname: '0.0.0.0',
      dbPath: '/srv/herald/data/herald.db',
      telegramApiUrl: 'http://127.0.0.1:9999',
      maxWaitMs: 25_000,
    });
  });

  test('нет обязательной переменной — ConfigError с её именем', () => {
    for (const name of Object.keys(required)) {
      const env: Record<string, string> = { ...required };
      delete env[name];
      expect(() => ServerConfig.fromEnv(env)).toThrow(name);
      env[name] = '  ';
      expect(() => ServerConfig.fromEnv(env)).toThrow(ConfigError);
    }
  });

  test('ошибка доступа — ConfigError', () => {
    expect(() => ServerConfig.fromEnv({ ...required, HERALD_PEOPLE: 'ann:222' })).toThrow(ConfigError);
  });

  test('неверные числа — ConfigError', () => {
    for (const [name, value] of [
      ['HERALD_PORT', 'abc'],
      ['HERALD_PORT', '70000'],
      ['HERALD_MAX_WAIT_SECONDS', '0'],
      ['HERALD_MAX_WAIT_SECONDS', '241'],
    ] as const) {
      expect(() => ServerConfig.fromEnv({ ...required, [name]: value })).toThrow(name);
    }
  });
});
