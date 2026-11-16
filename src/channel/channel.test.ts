import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';
import { HeraldChannel } from './channel.ts';
import { FakeHerald } from './herald.fake.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(options: { permissionRelay?: boolean } = {}) {
  const herald = new FakeHerald();
  const logs: string[] = [];
  const channel = new HeraldChannel({ herald, log: (m) => logs.push(m), retryDelayMs: 5, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const events: JSONRPCNotification[] = [];
  client.fallbackNotificationHandler = async (n) => {
    events.push(n as JSONRPCNotification);
  };
  await channel.connect(serverSide);
  await client.connect(clientSide);
  cleanup.push(
    () => channel.close(),
    () => client.close(),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError ?? false };
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(5);
    expect(cond()).toBe(true);
  };
  return { herald, channel, client, events, call, until, logs };
}

describe('HeraldChannel — объявление', () => {
  test('capability claude/channel, инструкции; без подтверждения действий по умолчанию', async () => {
    const { client } = await setup();
    const caps = client.getServerCapabilities();
    expect(caps?.experimental?.['claude/channel']).toEqual({});
    expect(caps?.experimental?.['claude/channel/permission']).toBeUndefined();
    expect(caps?.tools).toBeDefined();
    expect(client.getInstructions()).toContain('reply');
  });

  test('инструменты: reply, notify, ask, decide, status', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ask', 'decide', 'notify', 'reply', 'status']);
    for (const t of tools) expect(t.description).toBeString();
  });
});

describe('HeraldChannel — инструменты', () => {
  test('reply и notify — уведомление человеку', async () => {
    const { herald, call } = await setup();
    expect((await call('reply', { text: 'Готово' })).isError).toBe(false);
    await call('notify', { text: 'Фаза 5' });
    expect(herald.notified).toEqual(['Готово', 'Фаза 5']);
  });

  test('status', async () => {
    const { herald, call } = await setup();
    await call('status', { text: 'Фаза 5: канал' });
    expect(herald.statuses).toEqual(['Фаза 5: канал']);
  });

  test('ask — сразу id вопроса, без ожидания ответа', async () => {
    const { herald, call } = await setup();
    const r = await call('ask', {
      text: 'Какую БД?',
      options: [
        { id: 'A', text: 'SQLite' },
        { id: 'B', text: 'Postgres' },
      ],
      recommended: 'A',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('q_1');
    expect(herald.asked).toEqual([
      {
        text: 'Какую БД?',
        options: [
          { id: 'A', text: 'SQLite' },
          { id: 'B', text: 'Postgres' },
        ],
        recommended: 'A',
      },
    ]);
  });

  test('ask без вариантов', async () => {
    const { herald, call } = await setup();
    await call('ask', { text: 'Как назвать?' });
    expect(herald.asked).toEqual([{ text: 'Как назвать?', options: [] }]);
  });

  test('decide — вариант или текст, с причиной', async () => {
    const { herald, call } = await setup();
    await call('decide', { question_id: 'q_7', option: 'A', reason: 'по таймауту' });
    await call('decide', { question_id: 'q_8', text: 'herald', reason: 'по таймауту' });
    expect(herald.decided).toEqual([
      { id: 'q_7', choice: { option: 'A' }, reason: 'по таймауту' },
      { id: 'q_8', choice: { text: 'herald' }, reason: 'по таймауту' },
    ]);
  });

  test('неверные аргументы и ошибка сервера — isError с текстом', async () => {
    const { herald, call } = await setup();
    expect(await call('reply', {})).toMatchObject({ isError: true, text: expect.stringContaining('text') });
    expect((await call('decide', { question_id: 'q', reason: 'r' })).isError).toBe(true);
    expect((await call('ask', { text: 'x', options: [{ id: 'A' }] })).isError).toBe(true);
    herald.failNext('бот заблокирован');
    expect(await call('reply', { text: 'x' })).toMatchObject({
      isError: true,
      text: expect.stringContaining('бот заблокирован'),
    });
    expect((await call('nope', {})).isError).toBe(true);
  });
});

describe('HeraldChannel — входящие событиями', () => {
  test('указание, ответ, поздний ответ → notifications/claude/channel с meta; затем подтверждение прочтения', async () => {
    const { herald, channel, events, until } = await setup();
    channel.start();
    herald.push(
      { id: 'i_1', kind: 'directive', text: 'Займись тестами', createdAt: 1 },
      { id: 'i_2', kind: 'answer', text: 'B: Postgres', questionId: 'q_1', option: 'B', createdAt: 2 },
      { id: 'i_3', kind: 'late-answer', text: 'herald', questionId: 'q_2', createdAt: 3 },
    );
    await until(() => herald.acked.length === 3);

    expect(events.map((e) => e.method)).toEqual(Array(3).fill('notifications/claude/channel'));
    expect(events.map((e) => e.params)).toEqual([
      { content: 'Займись тестами', meta: { kind: 'directive', item_id: 'i_1' } },
      {
        content: 'Ответ на вопрос q_1: B: Postgres',
        meta: { kind: 'answer', item_id: 'i_2', question_id: 'q_1', option: 'B' },
      },
      {
        content: 'Переигрывание вопроса q_2: herald',
        meta: { kind: 'late-answer', item_id: 'i_3', question_id: 'q_2' },
      },
    ]);
    expect(herald.acked).toEqual(['i_1', 'i_2', 'i_3']);
  });

  test('сбой сервера в цикле — в лог, пауза, цикл продолжается', async () => {
    const { herald, channel, events, until, logs } = await setup();
    herald.failNext('сервер недоступен');
    channel.start();
    await until(() => logs.length > 0);
    herald.push({ id: 'i_1', kind: 'directive', text: 'Ты тут?', createdAt: 1 });
    await until(() => events.length === 1);
    expect(logs[0]).toContain('сервер недоступен');
  });

  test('close останавливает цикл', async () => {
    const { herald, channel } = await setup();
    channel.start();
    await Bun.sleep(20);
    await channel.close();
    const polls = herald.polls;
    await Bun.sleep(30);
    expect(herald.polls).toBe(polls);
  });
});
