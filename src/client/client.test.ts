import { afterEach, describe, expect, test } from 'bun:test';
import { AgentService } from '../app/agent.ts';
import { HumanService } from '../app/human.ts';
import { FakeTelegram } from '../app/telegram.fake.ts';
import { NUR_CHAT, SeqIds } from '../app/testkit.fake.ts';
import { Waiter } from '../app/waiter.ts';
import { Access } from '../domain/access.ts';
import { HttpApi } from '../http/api.ts';
import { SqliteStore } from '../infra/sqlite-store.ts';
import { SystemClock } from '../infra/system.ts';
import { HeraldClient, HeraldClientError } from './client.ts';

const session = { host: 'laptop', root: '/home/nur/dev/u7-school' };
const options = [
  { id: 'A', text: 'SQLite' },
  { id: 'B', text: 'Postgres' },
];

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Настоящий HttpApi на системных часах с коротким потолком ожидания — чтобы клиент переподключался. */
function setup(maxWaitMs = 40) {
  const clock = new SystemClock();
  const telegram = new FakeTelegram();
  const deps = {
    store: SqliteStore.open(':memory:'),
    telegram,
    access: Access.parse('nur:t-nur', `nur:${NUR_CHAT}`),
    clock,
    ids: new SeqIds(),
    waiter: new Waiter(clock),
  };
  const human = new HumanService(deps);
  const calls: string[] = [];
  const api = new HttpApi({ agent: new AgentService(deps), access: deps.access, maxWaitMs });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      calls.push(new URL(req.url).pathname);
      return api.fetch(req);
    },
  });
  cleanup.push(() => server.stop(true));
  const client = (token = 't-nur', serverUrl = `http://127.0.0.1:${server.port}`) =>
    new HeraldClient({ serverUrl, token, session, clock, retryDelayMs: 5 });
  let updateId = 0;
  const press = (data: string) =>
    human.handle({
      kind: 'callback',
      updateId: ++updateId,
      callbackId: `cb${updateId}`,
      chatId: NUR_CHAT,
      messageId: telegram.last(NUR_CHAT)!.messageId,
      data,
    });
  const reply = (text: string) =>
    human.handle({
      kind: 'message',
      updateId: ++updateId,
      chatId: NUR_CHAT,
      messageId: 900 + updateId,
      text,
      replyTo: telegram.last(NUR_CHAT)!.messageId,
    });
  return { telegram, calls, client, press, reply };
}

describe('HeraldClient', () => {
  test('notify, status, ask, decide — через HTTP API', async () => {
    const k = setup();
    const c = k.client();
    await c.notify('Готово');
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('[laptop · u7-school]\nГотово');
    await c.status('Фаза 4');
    await c.title('ревью');
    await c.bye();
    await c.notify('Ещё');
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('[laptop · u7-school · ревью]\nЕщё');
    const q = await c.ask({ text: 'Какую БД?', options, recommended: 'A' });
    expect(q.status).toBe('open');
    const decided = await c.decide(q.id, { option: 'A' }, 'по таймауту');
    expect(decided.resolution).toMatchObject({ by: 'agent', option: 'A' });
  });

  test('awaitQuestion переподключается, пока не придёт ответ', async () => {
    const k = setup();
    const c = k.client();
    const q = await c.ask({ text: 'Какую БД?', options });
    const waiting = c.awaitQuestion(q.id, 5_000);
    await Bun.sleep(150);
    await k.press(`a:${q.id}:B`);
    const answered = await waiting;
    expect(answered.resolution).toMatchObject({ by: 'human', option: 'B' });
    expect(k.calls.filter((p) => p === '/v1/question').length).toBeGreaterThan(1);
  });

  test('awaitQuestion по таймауту — открытый вопрос', async () => {
    const k = setup();
    const c = k.client();
    const q = await c.ask({ text: 'Какую БД?', options });
    const started = performance.now();
    expect((await c.awaitQuestion(q.id, 120)).status).toBe('open');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('awaitQuestion без таймаута ждёт сколько нужно', async () => {
    const k = setup();
    const c = k.client();
    const q = await c.ask({ text: 'Как назвать?', options: [] });
    const waiting = c.awaitQuestion(q.id);
    await Bun.sleep(200);
    await k.reply('herald');
    expect((await waiting).resolution).toMatchObject({ text: 'herald' });
  });

  test('inbox: ожидание с переподключением, ack', async () => {
    const k = setup();
    const c = k.client();
    await c.notify('Готово');
    expect(await c.inbox(0)).toEqual([]);
    const waiting = c.inbox(5_000);
    await Bun.sleep(120);
    await k.reply('Займись тестами');
    const items = await waiting;
    expect(items.map((i) => i.text)).toEqual(['Займись тестами']);
    expect(await c.ack(items.map((i) => i.id))).toEqual([items[0]!.id]);
    expect(await c.inbox(60)).toEqual([]);
  });

  test('inbox с видами — только они', async () => {
    const k = setup();
    const c = k.client();
    await c.notify('Готово');
    await k.reply('Займись тестами');
    expect(await c.inbox(0, ['command'])).toEqual([]);
    expect((await c.inbox(0, ['directive'])).map((i) => i.text)).toEqual(['Займись тестами']);
  });

  test('ошибка сервера — HeraldClientError со статусом и текстом', async () => {
    const k = setup();
    const error = await k
      .client('t-unknown')
      .notify('x')
      .catch((e) => e);
    expect(error).toBeInstanceOf(HeraldClientError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('токен');
  });

  test('сервер недоступен: обычный вызов — ошибка сразу; ожидание — повторы до таймаута', async () => {
    const k = setup();
    const down = k.client('t-nur', 'http://127.0.0.1:1');
    const error = await down.notify('x').catch((e) => e);
    expect(error).toBeInstanceOf(HeraldClientError);
    expect(error.status).toBeUndefined();
    const started = performance.now();
    await expect(down.inbox(100)).rejects.toBeInstanceOf(HeraldClientError);
    expect(performance.now() - started).toBeGreaterThanOrEqual(90);
  });
});
