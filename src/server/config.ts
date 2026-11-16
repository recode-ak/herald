import { Access, AccessConfigError } from '../domain/access.ts';
import { HttpApi } from '../http/api.ts';

/** Ошибка конфига сервера: сервер не запускается. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

/**
 * Настройки сервера из окружения (Bun сам читает `.env` из каталога запуска).
 * Обязательные: `HERALD_TOKENS`, `HERALD_PEOPLE`, `HERALD_BOT_TOKEN`; остальные — со значениями по умолчанию.
 */
export class ServerConfig {
  private constructor(
    readonly access: Access,
    readonly botToken: string,
    readonly telegramApiUrl: string,
    readonly port: number,
    readonly hostname: string,
    readonly dbPath: string,
    readonly maxWaitMs: number,
  ) {}

  static fromEnv(env: Env): ServerConfig {
    const access = ServerConfig.access(
      ServerConfig.required(env, 'HERALD_TOKENS'),
      ServerConfig.required(env, 'HERALD_PEOPLE'),
    );
    return new ServerConfig(
      access,
      ServerConfig.required(env, 'HERALD_BOT_TOKEN'),
      (env.HERALD_TELEGRAM_API?.trim() || 'https://api.telegram.org').replace(/\/+$/, ''),
      ServerConfig.integer(env, 'HERALD_PORT', 4518, 0, 65_535),
      env.HERALD_HOSTNAME?.trim() || '127.0.0.1',
      env.HERALD_DB?.trim() || './data/herald.db',
      ServerConfig.integer(env, 'HERALD_MAX_WAIT_SECONDS', 50, 1, HttpApi.MAX_WAIT_LIMIT_MS / 1000) * 1000,
    );
  }

  private static required(env: Env, name: string): string {
    const value = env[name]?.trim();
    if (!value) throw new ConfigError(`${name} не задана`);
    return value;
  }

  private static integer(env: Env, name: string, fallback: number, min: number, max: number): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new ConfigError(`${name}: «${raw}» — ожидается целое от ${min} до ${max}`);
    }
    return value;
  }

  private static access(tokens: string, people: string): Access {
    try {
      return Access.parse(tokens, people);
    } catch (error) {
      if (error instanceof AccessConfigError) throw new ConfigError(error.message);
      throw error;
    }
  }
}
