import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';
import type { AskItem } from '../client/client.ts';
import { HeraldChannel, type Terminal } from './channel.ts';
import { FakeHerald } from './herald.fake.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(
  options: { permissionRelay?: boolean; terminal?: Terminal; events?: boolean; silent?: boolean } = {},
) {
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
    expect(tools.map((t) => t.name).sort()).toEqual([
      'answered',
      'ask',
      'decide',
      'notify',
      'reply',
      'status',
      'title',
    ]);
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

  test('close — herald узнаёт, что окно закрыто; сбой bye не мешает закрытию', async () => {
    const first = await setup();
    await first.channel.close();
    expect(first.herald.byes).toBe(1);
    const second = await setup();
    second.herald.failNext('сеть');
    await second.channel.close();
  });

  test('title — название сессии', async () => {
    const { herald, call } = await setup();
    await call('title', { text: 'dmg-ui · Ф4' });
    expect(herald.titles).toEqual(['dmg-ui · Ф4']);
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

  test('ask с timeout_seconds — таймаут в мс; неверный — isError', async () => {
    const { herald, call } = await setup();
    await call('ask', { text: 'БД?', options: [{ id: 'A', text: 'SQLite' }], timeout_seconds: 180 });
    expect(herald.asked.at(-1)).toMatchObject({ timeoutMs: 180_000 });
    for (const timeout_seconds of [-1, 1.5, '180']) {
      expect((await call('ask', { text: 'БД?', timeout_seconds })).isError).toBe(true);
    }
    expect(herald.asked).toHaveLength(1);
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

  test('answered — вариант или текст: человек ответил в терминале', async () => {
    const { herald, call } = await setup();
    expect((await call('answered', { question_id: 'q_7', option: 'A' })).isError).toBe(false);
    await call('answered', { question_id: 'q_8', text: 'herald' });
    expect((await call('answered', { question_id: 'q_9' })).isError).toBe(true);
    expect(herald.answeredInTerminal).toEqual([
      { id: 'q_7', choice: { option: 'A' } },
      { id: 'q_8', choice: { text: 'herald' } },
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

describe('HeraldChannel — команды терминала', () => {
  test('команда → терминал окна, событием в сессию не идёт; подтверждение прочтения', async () => {
    const sent: string[] = [];
    const { herald, channel, events, until } = await setup({ terminal: { send: async (c) => void sent.push(c) } });
    channel.start();
    herald.push(
      { id: 'i_1', kind: 'command', text: '/compact', createdAt: 1 },
      { id: 'i_2', kind: 'directive', text: 'дальше', createdAt: 2 },
    );
    await until(() => herald.acked.length === 2);
    expect(sent).toEqual(['/compact']);
    expect(events.map((e) => e.params?.content)).toEqual(['дальше']);
    expect(herald.notified).toEqual([]);
  });

  test('после команды — статус сессии: человек видит в /sessions, что контекст сброшен', async () => {
    const { herald, channel, until } = await setup({ terminal: { send: async () => undefined } });
    channel.start();
    herald.push(
      { id: 'i_1', kind: 'command', text: '/clear', createdAt: 1 },
      { id: 'i_2', kind: 'command', text: '/compact', createdAt: 2 },
    );
    await until(() => herald.acked.length === 2);
    expect(herald.statuses).toEqual(['🧹 /clear — контекст сброшен, жду указаний', '🗜 /compact — контекст сжат']);
  });

  test('сбой статуса после команды — команда не повторяется, прочтение подтверждается', async () => {
    const sent: string[] = [];
    const { herald, channel, until } = await setup({ terminal: { send: async (c) => void sent.push(c) } });
    channel.start();
    herald.push({ id: 'i_1', kind: 'command', text: '/clear', createdAt: 1 });
    herald.failNext('сеть');
    await until(() => herald.acked.length === 1);
    expect(sent).toEqual(['/clear']);
  });

  test('окно не в tmux или сбой терминала — человеку уведомление, прочтение подтверждается', async () => {
    const none = await setup();
    none.channel.start();
    none.herald.push({ id: 'i_1', kind: 'command', text: '/clear', createdAt: 1 });
    await none.until(() => none.herald.acked.length === 1);
    expect(none.herald.notified).toEqual(['⚠️ /clear не выполнена: окно агента запущено не в tmux.']);

    const broken = await setup({
      terminal: {
        send: async () => {
          throw new Error('no server running');
        },
      },
    });
    broken.channel.start();
    broken.herald.push({ id: 'i_1', kind: 'command', text: '/compact', createdAt: 1 });
    await broken.until(() => broken.herald.acked.length === 1);
    expect(broken.herald.notified).toEqual(['⚠️ /compact не выполнена: no server running']);
  });
});

describe('HeraldChannel — подтверждение действий из Telegram', () => {
  const request = {
    request_id: 'abcde',
    tool_name: 'Bash',
    description: 'Удалить сборку',
    input_preview: '{"command":"rm -rf dist"}',
  };
  const relay = (client: Client) =>
    client.notification({ method: 'notifications/claude/channel/permission_request', params: request });

  test('выключено по умолчанию: capability нет, запрос игнорируется', async () => {
    const { client, herald } = await setup();
    expect(client.getServerCapabilities()?.experimental?.['claude/channel/permission']).toBeUndefined();
    await relay(client);
    await Bun.sleep(30);
    expect(herald.asked).toEqual([]);
  });

  test('permission_request → вопрос «разрешить / запретить» → permission allow; событием в сессию не идёт', async () => {
    const { client, herald, channel, events, until } = await setup({ permissionRelay: true });
    expect(client.getServerCapabilities()?.experimental?.['claude/channel/permission']).toEqual({});
    channel.start();
    await relay(client);
    await until(() => herald.asked.length === 1);
    const asked = herald.asked[0] as AskItem;
    expect(asked.text).toContain('Bash');
    expect(asked.text).toContain('Удалить сборку');
    expect(asked.text).toContain('rm -rf dist');
    expect(asked.options).toEqual([
      { id: 'allow', text: 'Разрешить' },
      { id: 'deny', text: 'Запретить' },
    ]);

    herald.push({
      id: 'i_1',
      kind: 'answer',
      text: 'allow: Разрешить',
      questionId: 'q_1',
      option: 'allow',
      createdAt: 1,
    });
    await until(() => herald.acked.includes('i_1'));
    expect(events).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/claude/channel/permission',
        params: { request_id: 'abcde', behavior: 'allow' },
      },
    ]);
  });

  test('«Запретить» и свободный текст — deny; поздний ответ — не событие', async () => {
    const { client, herald, channel, events, until } = await setup({ permissionRelay: true });
    channel.start();
    await relay(client);
    await relay(client);
    await until(() => herald.asked.length === 2);
    herald.push(
      { id: 'i_1', kind: 'answer', text: 'deny: Запретить', questionId: 'q_1', option: 'deny', createdAt: 1 },
      { id: 'i_2', kind: 'answer', text: 'давай', questionId: 'q_2', createdAt: 2 },
      { id: 'i_3', kind: 'late-answer', text: 'allow: Разрешить', questionId: 'q_1', option: 'allow', createdAt: 3 },
    );
    await until(() => herald.acked.length === 3);
    expect(events.map((e) => e.params)).toEqual([
      { request_id: 'abcde', behavior: 'deny' },
      { request_id: 'abcde', behavior: 'deny' },
    ]);
  });

  test('сбой ask — в лог', async () => {
    const { client, herald, logs, until } = await setup({ permissionRelay: true });
    herald.failNext('бот заблокирован');
    await relay(client);
    await until(() => logs.some((l) => l.includes('бот заблокирован')));
  });
});

describe('HeraldChannel — без событий (Claude Code запущен без флага канала)', () => {
  test('по умолчанию события есть: инструкции говорят, что канал подключён; инструмента inbox нет', async () => {
    const { client } = await setup();
    expect(client.getInstructions()).toContain('Канал подключён');
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('inbox');
  });

  test('инструкции — «канал не подключён», есть инструмент inbox; подтверждения действий нет', async () => {
    const { client } = await setup({ events: false, permissionRelay: true });
    expect(client.getInstructions()).toContain('Канал не подключён');
    expect(client.getInstructions()).toContain('inbox');
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('inbox');
    expect(client.getServerCapabilities()?.experimental?.['claude/channel/permission']).toBeUndefined();
  });

  test('цикл берёт только команды; указания ждут в ящике, событий и прочтения нет', async () => {
    const sent: string[] = [];
    const { herald, channel, events, until } = await setup({
      events: false,
      silent: true,
      terminal: { send: async (c) => void sent.push(c) },
    });
    channel.start();
    herald.push(
      { id: 'i_1', kind: 'directive', text: 'дальше', createdAt: 1 },
      { id: 'i_2', kind: 'command', text: '/compact', createdAt: 2 },
    );
    await until(() => herald.acked.length === 1);
    expect(herald.lastKinds).toEqual(['command']);
    expect(sent).toEqual(['/compact']);
    expect(herald.acked).toEqual(['i_2']);
    await Bun.sleep(30);
    expect(events).toEqual([]);
    expect(herald.acked).toEqual(['i_2']);
  });

  test('inbox — указания и ответы текстом с id, затем прочтение; команд не берёт', async () => {
    const { herald, call } = await setup({ events: false, silent: true });
    herald.push(
      { id: 'i_1', kind: 'directive', text: 'Займись тестами', createdAt: 1 },
      { id: 'i_2', kind: 'answer', text: 'B: Postgres', questionId: 'q_1', option: 'B', createdAt: 2 },
    );
    const r = await call('inbox', { wait_seconds: 5 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('kind=directive item_id=i_1');
    expect(r.text).toContain('Займись тестами');
    expect(r.text).toContain('kind=answer item_id=i_2 question_id=q_1 option=B');
    expect(r.text).toContain('Ответ на вопрос q_1: B: Postgres');
    expect(herald.lastKinds).toEqual(['directive', 'answer', 'late-answer']);
    expect(herald.acked).toEqual(['i_1', 'i_2']);
    expect((await call('inbox', {})).text).toContain('входящих нет');
    expect((await call('inbox', { wait_seconds: 'x' })).isError).toBe(true);
  });

  test('ask — ответ забирать инструментом inbox', async () => {
    const { call } = await setup({ events: false, silent: true });
    expect((await call('ask', { text: 'Какую БД?' })).text).toContain('inbox');
  });

  test('при старте — предупреждение человеку; silent (claude -p) — без него', async () => {
    const loud = await setup({ events: false });
    loud.channel.start();
    await loud.until(() => loud.herald.notified.length === 1);
    expect(loud.herald.notified[0]).toContain('без канала');

    const quiet = await setup({ events: false, silent: true });
    quiet.channel.start();
    await Bun.sleep(30);
    expect(quiet.herald.notified).toEqual([]);

    const normal = await setup();
    normal.channel.start();
    await Bun.sleep(30);
    expect(normal.herald.notified).toEqual([]);
  });
});
