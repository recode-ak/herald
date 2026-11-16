import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

/** Ошибка настроек клиента: команда не выполняется. */
export class ClientConfigError extends Error {
  override name = 'ClientConfigError';
}

type Env = Record<string, string | undefined>;

/**
 * Настройки клиента (CLI и канал): `~/.config/herald/config.json` `{ serverUrl, token, host? }`.
 * Переменные `HERALD_URL`, `HERALD_TOKEN`, `HERALD_HOST` важнее файла; `HERALD_CONFIG` — другой путь к файлу.
 */
export class ClientConfig {
  static readonly DEFAULT_PATH = join(homedir(), '.config', 'herald', 'config.json');

  private constructor(
    readonly serverUrl: string,
    readonly token: string,
    readonly host: string,
    /** Откуда читали — для сообщений об ошибках. */
    readonly path: string,
  ) {}

  static load(env: Env): ClientConfig {
    const path = env.HERALD_CONFIG?.trim() || ClientConfig.DEFAULT_PATH;
    const file = ClientConfig.readFile(path);
    const fail = (message: string) => new ClientConfigError(`настройки herald (${path}): ${message}`);
    const pick = (name: string, envName: string): string | undefined => {
      const fromEnv = env[envName]?.trim();
      if (fromEnv) return fromEnv;
      const value = file[name];
      if (value === undefined) return undefined;
      if (typeof value !== 'string') throw fail(`${name} — ожидается строка`);
      return value.trim() || undefined;
    };

    const serverUrl = pick('serverUrl', 'HERALD_URL');
    if (!serverUrl) throw fail('serverUrl не задан (или HERALD_URL)');
    if (!URL.canParse(serverUrl)) throw fail(`serverUrl «${serverUrl}» — не URL`);
    const token = pick('token', 'HERALD_TOKEN');
    if (!token) throw fail('token не задан (или HERALD_TOKEN)');
    const host = pick('host', 'HERALD_HOST') ?? hostname();
    return new ClientConfig(serverUrl.replace(/\/+$/, ''), token, host, path);
  }

  private static readFile(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new ClientConfigError(`настройки herald (${path}): не JSON — ${(error as Error).message}`);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new ClientConfigError(`настройки herald (${path}): ожидается JSON-объект`);
    }
    return data as Record<string, unknown>;
  }
}
