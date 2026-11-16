import { afterEach, describe, expect, test } from 'bun:test';
import type { TelegramUpdate } from '../app/telegram.ts';
import { FakeBotApi } from './bot-api.fake.ts';
import { SqliteStore } from './sqlite-store.ts';
import { SystemClock } from './system.ts';
import { TelegramBotApi } from './telegram.ts';
import { TelegramPoller } from './telegram-poller.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const text = (message_id: number, t: string) => ({ message: { message_id, chat: { id: 111 }, text: t } });

function setup(handle: (u: TelegramUpdate) => Promise<void> = async () => {}) {
  const fake = new FakeBotApi();
  cleanup.push(() => fake.stop());
  const clock = new SystemClock();
  const api = new TelegramBotApi({ token: fake.token, baseUrl: fake.baseUrl, clock, retries: 0 });
  const store = SqliteStore.open(':memory:');
  const handled: TelegramUpdate[] = [];
  const logs: string[] = [];
  const poller = (s = store) => {
    const p = new TelegramPoller({
      api,
      store: s,
      clock,
      human: {
        handle: async (u) => {
          handled.push(u);
          await handle(u);
        },
      },
      pollTimeoutSec: 1,
      errorDelayMs: 5,
      log: (m) => logs.push(m),
    });
    cleanup.push(() => p.stop());
    return p;
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(5);
    expect(cond()).toBe(true);
  };
  return { fake, store, handled, logs, poller, until };
}

describe('TelegramPoller', () => {
  test('апдейты — сценариям по порядку; offset сохраняется после каждого', async () => {
    const k = setup();
    k.fake.pushUpdate(text(1, 'a'));
    k.fake.pushUpdate(text(2, 'b'));
    k.poller().start();
    await k.until(() => k.handled.length === 2);
    expect(k.handled.map((u) => (u.kind === 'message' ? u.text : ''))).toEqual(['a', 'b']);
    expect(k.store.telegramOffset()).toBe(3);

    k.fake.pushUpdate(text(3, 'c'));
    await k.until(() => k.handled.length === 3);
    expect(k.store.telegramOffset()).toBe(4);
  });

  test('после перезапуска продолжает с сохранённого offset — без повторов', async () => {
    const k = setup();
    k.fake.pushUpdate(text(1, 'a'));
    const first = k.poller();
    first.start();
    await k.until(() => k.handled.length === 1);
    await first.stop();

    k.fake.pushUpdate(text(2, 'b'));
    k.poller().start();
    await k.until(() => k.handled.length === 2);
    expect(k.handled.map((u) => u.updateId)).toEqual([1, 2]);
  });

  test('пропущенный апдейт (не текст) двигает offset', async () => {
    const k = setup();
    k.fake.pushUpdate({ message: { message_id: 1, chat: { id: 111 }, sticker: {} } });
    k.poller().start();
    await k.until(() => k.store.telegramOffset() === 2);
    expect(k.handled).toEqual([]);
  });

  test('сбой сценария — в лог, апдейт не повторяется, опрос идёт дальше', async () => {
    const k = setup(async (u) => {
      if (u.updateId === 1) throw new Error('сломалось');
    });
    k.fake.pushUpdate(text(1, 'a'));
    k.fake.pushUpdate(text(2, 'b'));
    k.poller().start();
    await k.until(() => k.handled.length === 2);
    expect(k.logs.some((l) => l.includes('сломалось'))).toBe(true);
    expect(k.store.telegramOffset()).toBe(3);
  });

  test('сбой getUpdates — в лог, пауза и новая попытка', async () => {
    const k = setup();
    k.fake.failNext('getUpdates', { status: 409, body: { ok: false, error_code: 409, description: 'Conflict' } });
    k.fake.pushUpdate(text(1, 'a'));
    k.poller().start();
    await k.until(() => k.handled.length === 1);
    expect(k.logs.some((l) => l.includes('Conflict'))).toBe(true);
  });

  test('stop обрывает long poll и ждёт завершения цикла', async () => {
    const k = setup();
    const p = k.poller();
    p.start();
    await k.until(() => k.fake.callsOf('getUpdates').length === 1);
    const started = performance.now();
    await p.stop();
    expect(performance.now() - started).toBeLessThan(500);
    expect(k.logs).toEqual([]);
  });
});
