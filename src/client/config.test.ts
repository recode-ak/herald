import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientConfig, ClientConfigError } from './config.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function file(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'herald-cfg-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

describe('ClientConfig.load', () => {
  test('из файла HERALD_CONFIG; хвостовой / у адреса убирается', () => {
    const path = file({ serverUrl: 'https://herald.u7-hub.kz/', token: 't', host: 'laptop' });
    expect(ClientConfig.load({ HERALD_CONFIG: path })).toEqual({
      serverUrl: 'https://herald.u7-hub.kz',
      token: 't',
      host: 'laptop',
      path,
    });
  });

  test('переменные окружения важнее файла', () => {
    const path = file({ serverUrl: 'https://a', token: 't', host: 'laptop' });
    const config = ClientConfig.load({
      HERALD_CONFIG: path,
      HERALD_URL: 'http://127.0.0.1:4518',
      HERALD_TOKEN: 't2',
      HERALD_HOST: 'pc',
    });
    expect(config).toMatchObject({ serverUrl: 'http://127.0.0.1:4518', token: 't2', host: 'pc' });
  });

  test('без файла — только из окружения; host по умолчанию — имя машины', () => {
    const config = ClientConfig.load({ HERALD_CONFIG: '/нет/такого.json', HERALD_URL: 'http://x', HERALD_TOKEN: 't' });
    expect(config.host).toBe(hostname());
  });

  test('нет адреса или токена, неверный URL, битый JSON — ClientConfigError с путём', () => {
    const missing = '/нет/такого.json';
    expect(() => ClientConfig.load({ HERALD_CONFIG: missing, HERALD_TOKEN: 't' })).toThrow('serverUrl');
    expect(() => ClientConfig.load({ HERALD_CONFIG: missing, HERALD_URL: 'http://x' })).toThrow('token');
    expect(() => ClientConfig.load({ HERALD_CONFIG: missing, HERALD_URL: 'не url', HERALD_TOKEN: 't' })).toThrow(
      ClientConfigError,
    );
    const broken = file('{');
    expect(() => ClientConfig.load({ HERALD_CONFIG: broken })).toThrow(broken);
    expect(() => ClientConfig.load({ HERALD_CONFIG: file({ serverUrl: 5, token: 't' }) })).toThrow('serverUrl');
  });
});
