import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBotApi } from '../infra/bot-api.fake.ts';
import { ServerConfig } from './config.ts';
import { HeraldServer } from './herald-server.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const session = { host: 'laptop', root: '/home/nur/dev/u7-school' };

function env(fake: FakeBotApi, dbPath: string): Record<string, string> {
  return {
    HERALD_TOKENS: 'nur:t-nur',
    HERALD_PEOPLE: 'nur:111',
    HERALD_BOT_TOKEN: fake.token,
    HERALD_TELEGRAM_API: fake.baseUrl,
    HERALD_PORT: '0',
    HERALD_DB: dbPath,
    HERALD_MAX_WAIT_SECONDS: '5',
  };
}

function setup() {
  const fake = new FakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'herald-'));
  cleanup.push(
    () => fake.stop(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  return { fake, dir, dbPath: join(dir, 'data', 'herald.db') };
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(5);
  expect(cond()).toBe(true);
}

describe('HeraldServer', () => {
  test('сборка из конфига: ask → кнопка в Telegram → ответ в ждущем запросе', async () => {
    const { fake, dbPath } = setup();
    const server = HeraldServer.start(ServerConfig.fromEnv(env(fake, dbPath)), { log: () => {} });
    cleanup.push(() => server.stop());
    const call = (path: string, body: unknown) =>
      fetch(new URL(path, server.url), {
        method: 'POST',
        headers: { authorization: 'Bearer t-nur' },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<Record<string, { id: string; status: string }>>);

    const { question } = await call('/v1/ask', { session, text: 'Какую БД?', options: [{ id: 'A', text: 'SQLite' }] });
    expect(fake.callsOf('sendMessage')).toHaveLength(1);
    const waiting = call('/v1/question', { session, id: question!.id, waitMs: 5_000 });

    fake.pushUpdate({
      callback_query: { id: 'cb1', data: `a:${question!.id}:A`, message: { message_id: 1, chat: { id: 111 } } },
    });
    expect((await waiting).question!.status).toBe('answered');
    await until(() => fake.callsOf('answerCallbackQuery').length === 1);
  });

  test('база создаётся вместе с каталогом; offset переживает перезапуск', async () => {
    const { fake, dbPath } = setup();
    const config = ServerConfig.fromEnv(env(fake, dbPath));
    const first = HeraldServer.start(config, { log: () => {} });
    fake.pushUpdate({ message: { message_id: 1, chat: { id: 111 }, text: '/status' } });
    await until(() => fake.callsOf('sendMessage').length === 1);
    await first.stop();

    const second = HeraldServer.start(config, { log: () => {} });
    cleanup.push(() => second.stop());
    await until(() => fake.callsOf('getUpdates').some((p) => p.offset === 2));
    expect(fake.callsOf('sendMessage')).toHaveLength(1);
  });

  test('stop — быстро, даже с ждущим long poll; порт освобождён', async () => {
    const { fake, dbPath } = setup();
    const server = HeraldServer.start(ServerConfig.fromEnv(env(fake, dbPath)), { log: () => {} });
    const url = server.url;
    const pending = fetch(new URL('/v1/inbox', url), {
      method: 'POST',
      headers: { authorization: 'Bearer t-nur' },
      body: JSON.stringify({ session, waitMs: 5_000 }),
    }).catch(() => 'оборван');
    await Bun.sleep(20);

    const started = performance.now();
    await server.stop();
    expect(performance.now() - started).toBeLessThan(500);
    await pending;
    expect(await fetch(new URL('/health', url)).catch(() => 'нет')).toBe('нет');
  });
});
