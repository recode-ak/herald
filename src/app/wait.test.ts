import { describe, expect, test } from 'bun:test';
import { AgentService } from './agent.ts';
import { HumanService } from './human.ts';
import { NUR_CHAT, nur, testkit } from './testkit.fake.ts';

const db = {
  text: 'Какую БД?',
  options: [
    { id: 'A', text: 'SQLite' },
    { id: 'B', text: 'Postgres' },
  ],
};

function setup() {
  const kit = testkit();
  const human = new HumanService({ ...kit, activeWindowMs: 86_400_000 });
  let updateId = 0;
  return {
    ...kit,
    agent: new AgentService(kit),
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
  };
}

describe('Ожидание ответа на вопрос', () => {
  test('ответ кнопкой будит ожидание; ответ отмечен прочитанным и не дублируется во входящих', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const qMsg = k.telegram.last(NUR_CHAT)!;

    const waiting = k.agent.awaitQuestion(nur, q.id, 60_000);
    await k.press(qMsg.messageId, `a:${q.id}:B`);
    const result = await waiting;

    expect(result.status).toBe('answered');
    expect(result.resolution?.option).toBe('B');
    expect(await k.agent.inbox(nur)).toEqual([]);
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('✅ прочитано агентом · сессия u7-school');
  });

  test('уже отвеченный — сразу', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    await k.press(k.telegram.last(NUR_CHAT)!.messageId, `a:${q.id}:A`);
    expect((await k.agent.awaitQuestion(nur, q.id, 60_000)).status).toBe('answered');
  });

  test('таймаут — вопрос открыт; ничего не прочитано', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const waiting = k.agent.awaitQuestion(nur, q.id, 1000);
    k.clock.advance(1000);
    expect((await waiting).status).toBe('open');
  });

  test('«Жди меня» не завершает ожидание; ответ reply после — завершает', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const qMsg = k.telegram.last(NUR_CHAT)!;
    const waiting = k.agent.awaitQuestion(nur, q.id, 60_000);
    await k.press(qMsg.messageId, `h:${q.id}`);
    k.clock.advance(30_000);
    await k.reply('подумаю и скажу: B', qMsg.messageId);
    const result = await waiting;
    expect(result.resolution?.text).toBe('подумаю и скажу: B');
    expect(result.heldAt).toBeDefined();
  });

  test('чужой вопрос — отказ', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    await expect(k.agent.awaitQuestion({ ...nur, person: 'ann' }, q.id, 10)).rejects.toThrow();
  });
});

describe('Ожидание входящих', () => {
  test('указание будит ожидание', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    const waiting = k.agent.awaitInbox(nur, 60_000);
    await k.reply('стоп', k.telegram.last(NUR_CHAT)!.messageId);
    expect((await waiting).map((i) => i.text)).toEqual(['стоп']);
  });

  test('есть непрочитанные — сразу, без ожидания', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    await k.reply('стоп', k.telegram.last(NUR_CHAT)!.messageId);
    expect(await k.agent.awaitInbox(nur, 60_000)).toHaveLength(1);
    expect(k.clock.sleepers).toBe(0);
  });

  test('поздний ответ будит ожидание входящих', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const qMsg = k.telegram.last(NUR_CHAT)!;
    await k.agent.decide(nur, q.id, { option: 'A' }, 'по таймауту');
    const waiting = k.agent.awaitInbox(nur, 60_000);
    await k.press(qMsg.messageId, `a:${q.id}:B`);
    expect((await waiting).map((i) => i.kind)).toEqual(['late-answer']);
  });

  test('таймаут — пусто', async () => {
    const k = setup();
    const waiting = k.agent.awaitInbox(nur, 5000);
    k.clock.advance(5000);
    expect(await waiting).toEqual([]);
  });

  test('ответ на вопрос сессии без ожидающего вопроса — тоже во входящих (для канала)', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const waiting = k.agent.awaitInbox(nur, 60_000);
    await k.press(k.telegram.last(NUR_CHAT)!.messageId, `a:${q.id}:A`);
    expect((await waiting).map((i) => [i.kind, i.option])).toEqual([['answer', 'A']]);
  });
});
