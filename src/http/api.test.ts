import { afterEach, describe, expect, test } from 'bun:test';
import { AgentService } from '../app/agent.ts';
import { HumanService } from '../app/human.ts';
import { NUR_CHAT, testkit } from '../app/testkit.fake.ts';
import { HttpApi } from './api.ts';
import type { InboxItemWire, QuestionWire } from './wire.ts';

const session = { host: 'laptop', root: '/home/nur/dev/u7-school' };
const db = {
  text: 'Какую БД?',
  options: [
    { id: 'A', text: 'SQLite' },
    { id: 'B', text: 'Postgres' },
  ],
  recommended: 'A',
};

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function setup(maxWaitMs = 30_000) {
  const kit = testkit();
  const agent = new AgentService(kit);
  const human = new HumanService({ ...kit, activeWindowMs: 86_400_000 });
  const api = new HttpApi({ agent, access: kit.access, maxWaitMs });
  const server = api.listen({ port: 0, hostname: '127.0.0.1' });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  let updateId = 0;

  const call = async (path: string, body: unknown, token = 't-nur') => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  return {
    ...kit,
    base,
    call,
    press: (messageId: number, data: string) =>
      human.handle({
        kind: 'callback',
        updateId: ++updateId,
        callbackId: `cb${updateId}`,
        chatId: NUR_CHAT,
        messageId,
        data,
      }),
    reply: (text: string, replyTo: number) =>
      human.handle({
        kind: 'message',
        updateId: ++updateId,
        chatId: NUR_CHAT,
        messageId: 900 + updateId,
        text,
        replyTo,
      }),
    /** Дождаться, пока сервер уснёт в long poll. */
    sleeping: async () => {
      for (let i = 0; i < 200 && kit.clock.sleepers === 0; i++) await Bun.sleep(1);
      expect(kit.clock.sleepers).toBeGreaterThan(0);
    },
  };
}

describe('Доступ (КП 7)', () => {
  test('без токена и с неверным токеном — 401', async () => {
    const k = setup();
    const none = await fetch(`${k.base}/v1/notify`, { method: 'POST', body: JSON.stringify({ session, text: 'x' }) });
    expect(none.status).toBe(401);
    const wrong = await k.call('/v1/notify', { session, text: 'x' }, 't-unknown');
    expect(wrong.status).toBe(401);
    expect(wrong.json.error).toBeString();
    expect(k.telegram.sentTo(NUR_CHAT)).toEqual([]);
  });

  test('токен → человек: сообщение уходит в чат его человека', async () => {
    const k = setup();
    const res = await k.call('/v1/notify', { session, text: 'Фаза готова' });
    expect(res).toEqual({ status: 200, json: { ok: true } });
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('[laptop · u7-school]\nФаза готова');
  });

  test('вопрос другого человека — 403', async () => {
    const k = setup();
    const asked = await k.call('/v1/ask', { session, ...db });
    const id = (asked.json.question as QuestionWire).id;
    const res = await k.call('/v1/question', { session: { host: 'pc', root: '/x' }, id }, 't-ann');
    expect(res.status).toBe(403);
  });

  test('health — без токена', async () => {
    const k = setup();
    const res = await fetch(`${k.base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('Ошибки запроса', () => {
  test('неизвестный путь — 404, не POST — 405', async () => {
    const k = setup();
    expect((await k.call('/v1/nope', { session })).status).toBe(404);
    const get = await fetch(`${k.base}/v1/notify`, { headers: { authorization: 'Bearer t-nur' } });
    expect(get.status).toBe(405);
  });

  test('не JSON, нет сессии, неверные типы — 400 с текстом ошибки', async () => {
    const k = setup();
    const raw = await fetch(`${k.base}/v1/notify`, {
      method: 'POST',
      headers: { authorization: 'Bearer t-nur' },
      body: '{',
    });
    expect(raw.status).toBe(400);
    expect((await k.call('/v1/notify', { text: 'x' })).status).toBe(400);
    expect((await k.call('/v1/notify', { session, text: 5 })).status).toBe(400);
    expect((await k.call('/v1/inbox', { session, waitMs: -1 })).status).toBe(400);
  });

  test('нарушение правила домена — 400, нет объекта — 404, сбой Telegram — 502', async () => {
    const k = setup();
    const empty = await k.call('/v1/notify', { session, text: '  ' });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe('текст уведомления пуст');
    expect((await k.call('/v1/question', { session, id: 'q_нет' })).status).toBe(404);
    k.telegram.failNext('бот заблокирован');
    const failed = await k.call('/v1/notify', { session, text: 'x' });
    expect(failed).toEqual({ status: 502, json: { error: 'бот заблокирован' } });
  });
});

describe('Вопрос', () => {
  test('ask → вопрос с кнопками; ответ кнопкой будит ожидание (wait)', async () => {
    const k = setup();
    const asked = await k.call('/v1/ask', { session, ...db });
    expect(asked.status).toBe(200);
    const question = asked.json.question as QuestionWire;
    expect(question).toMatchObject({ status: 'open', text: 'Какую БД?', recommended: 'A', options: db.options });

    const waiting = k.call('/v1/question', { session, id: question.id, waitMs: 10_000 });
    await k.sleeping();
    await k.press(k.telegram.last(NUR_CHAT)!.messageId, `a:${question.id}:B`);
    const answered = (await waiting).json.question as QuestionWire;
    expect(answered.status).toBe('answered');
    expect(answered.resolution).toMatchObject({ by: 'human', option: 'B' });
  });

  test('wait по таймауту — вопрос open; wait ограничен maxWaitMs сервера', async () => {
    const k = setup(5_000);
    const id = ((await k.call('/v1/ask', { session, ...db })).json.question as QuestionWire).id;
    const waiting = k.call('/v1/question', { session, id, waitMs: 600_000 });
    await k.sleeping();
    k.clock.advance(5_000);
    expect(((await waiting).json.question as QuestionWire).status).toBe('open');
  });

  test('без wait — состояние сразу', async () => {
    const k = setup();
    const id = ((await k.call('/v1/ask', { session, ...db })).json.question as QuestionWire).id;
    const res = await k.call('/v1/question', { session, id });
    expect((res.json.question as QuestionWire).status).toBe('open');
  });

  test('ask без вариантов — только свободный ответ (reply)', async () => {
    const k = setup();
    const id = ((await k.call('/v1/ask', { session, text: 'Как назвать?' })).json.question as QuestionWire).id;
    await k.reply('herald', k.telegram.last(NUR_CHAT)!.messageId);
    const q = (await k.call('/v1/question', { session, id })).json.question as QuestionWire;
    expect(q.resolution).toMatchObject({ by: 'human', text: 'herald' });
  });

  test('decide — вариант с причиной; сообщение обновлено', async () => {
    const k = setup();
    const id = ((await k.call('/v1/ask', { session, ...db })).json.question as QuestionWire).id;
    const res = await k.call('/v1/decide', { session, id, option: 'A', reason: 'по таймауту' });
    expect(res.status).toBe(200);
    expect(res.json.question as QuestionWire).toMatchObject({
      status: 'decided',
      resolution: { by: 'agent', option: 'A', reason: 'по таймауту' },
    });
    expect(k.telegram.edits.length).toBe(1);
  });

  test('decide без варианта и текста — 400', async () => {
    const k = setup();
    const id = ((await k.call('/v1/ask', { session, ...db })).json.question as QuestionWire).id;
    expect((await k.call('/v1/decide', { session, id, reason: 'по таймауту' })).status).toBe(400);
  });
});

describe('Статус и входящие', () => {
  test('status — без отправки в Telegram', async () => {
    const k = setup();
    expect(await k.call('/v1/status', { session, text: 'Фаза 3' })).toEqual({ status: 200, json: { ok: true } });
    expect(k.telegram.sentTo(NUR_CHAT)).toEqual([]);
  });

  test('bye: сессия закрыта', async () => {
    const k = setup();
    expect(await k.call('/v1/bye', { session })).toEqual({ status: 200, json: { ok: true } });
  });

  test('title: название сессии; instance в session — отдельная сессия', async () => {
    const k = setup();
    const window = { ...session, instance: '02dc' };
    expect(await k.call('/v1/title', { session: window, text: 'ревью' })).toEqual({ status: 200, json: { ok: true } });
    await k.call('/v1/notify', { session: window, text: 'x' });
    expect(k.telegram.last(NUR_CHAT)?.text).toEndWith('·02dc · ревью]\nx');
    expect((await k.call('/v1/title', { session, text: ' ' })).status).toBe(400);
  });

  test('inbox: указание приходит в ждущий запрос; ack отмечает прочитанным', async () => {
    const k = setup();
    await k.call('/v1/notify', { session, text: 'Готово' });
    const notice = k.telegram.last(NUR_CHAT)!;

    const waiting = k.call('/v1/inbox', { session, waitMs: 10_000 });
    await k.sleeping();
    await k.reply('Займись тестами', notice.messageId);
    const items = (await waiting).json.items as InboxItemWire[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'directive', text: 'Займись тестами' });

    const ack = await k.call('/v1/ack', { session, ids: [items[0]!.id] });
    expect(ack).toEqual({ status: 200, json: { read: [items[0]!.id] } });
    expect((await k.call('/v1/inbox', { session })).json.items).toEqual([]);
    expect(k.telegram.reactions.at(-1)).toMatchObject({ chatId: NUR_CHAT, emoji: '👀' });
  });

  test('inbox по таймауту — пусто', async () => {
    const k = setup();
    const waiting = k.call('/v1/inbox', { session, waitMs: 1_000 });
    await k.sleeping();
    k.clock.advance(1_000);
    expect((await waiting).json.items).toEqual([]);
  });

  test('ack неизвестного id — 400', async () => {
    const k = setup();
    expect((await k.call('/v1/ack', { session, ids: ['i_нет'] })).status).toBe(400);
  });

  test('явная сессия (name)', async () => {
    const k = setup();
    await k.call('/v1/notify', { session: { ...session, name: 'ночь' }, text: 'x' });
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('[laptop · ночь]\nx');
  });
});
