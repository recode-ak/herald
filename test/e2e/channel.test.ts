/**
 * Сквозной канал: процесс `src/channel/main.ts` по stdio (как его запускает Claude Code) ↔ MCP-клиент SDK,
 * сервер herald в сборе и фейк Bot API. Живая сессия Claude Code (КП 6) — в смоуке Фазы 6.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FakeBotApi } from '../../src/infra/bot-api.fake.ts';
import { ServerConfig } from '../../src/server/config.ts';
import { HeraldServer } from '../../src/server/herald-server.ts';

const MAIN = join(import.meta.dir, '..', '..', 'src', 'channel', 'main.ts');
const NUR = 111;

let fake: FakeBotApi;
let server: HeraldServer;
let cwd: string;
let client: Client;
const events: { method: string; params?: Record<string, unknown> }[] = [];

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: cwd,
    HERALD_URL: server.url.href.replace(/\/$/, ''),
    HERALD_TOKEN: 't-nur',
    HERALD_HOST: 'laptop',
    HERALD_SESSION: 'claude',
    // Родитель — bun test, а не Claude Code с флагом канала.
    HERALD_CHANNEL_EVENTS: '1',
    ...extra,
  };
}

beforeAll(async () => {
  fake = new FakeBotApi();
  cwd = mkdtempSync(join(tmpdir(), 'herald-ch-'));
  server = HeraldServer.start(
    ServerConfig.fromEnv({
      HERALD_TOKENS: 'nur:t-nur',
      HERALD_PEOPLE: `nur:${NUR}`,
      HERALD_BOT_TOKEN: fake.token,
      HERALD_TELEGRAM_API: fake.baseUrl,
      HERALD_PORT: '0',
      HERALD_DB: ':memory:',
      HERALD_MAX_WAIT_SECONDS: '1',
    }),
    { log: () => {} },
  );
  client = new Client({ name: 'e2e', version: '0' });
  client.fallbackNotificationHandler = async (n) => {
    events.push(n as (typeof events)[number]);
  };
  await client.connect(new StdioClientTransport({ command: 'bun', args: [MAIN], cwd, env: env(), stderr: 'ignore' }));
});

afterAll(async () => {
  await client.close();
  await server.stop();
  fake.stop();
  rmSync(cwd, { recursive: true, force: true });
});

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !cond(); i++) await Bun.sleep(5);
  expect(cond()).toBe(true);
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join('\n');

describe('Канал по stdio', () => {
  test('capability claude/channel и инструменты', async () => {
    expect(client.getServerCapabilities()?.experimental?.['claude/channel']).toEqual({});
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'ask',
      'decide',
      'notify',
      'reply',
      'status',
      'title',
    ]);
  });

  test('reply → сообщение в Telegram; reply человека → событие в сессию, «прочитано агентом»', async () => {
    await client.callTool({ name: 'reply', arguments: { text: 'Фаза 5 готова' } });
    const notice = fake.sent.find((m) => FakeBotApi.plainText(m.params) === '[laptop · claude]\nФаза 5 готова');
    expect(notice).toBeDefined();

    fake.pushUpdate({
      message: {
        message_id: 5001,
        chat: { id: NUR },
        text: 'Займись доками',
        reply_to_message: { message_id: notice!.messageId },
      },
    });
    await until(() => events.some((e) => e.params?.content === 'Займись доками'));
    const event = events.find((e) => e.params?.content === 'Займись доками');
    expect(event?.method).toBe('notifications/claude/channel');
    expect(event?.params?.meta).toMatchObject({ kind: 'directive' });
    await until(() =>
      fake
        .callsOf('setMessageReaction')
        .some((p) => p.message_id === 5001 && JSON.stringify(p.reaction) === '[{"type":"emoji","emoji":"👀"}]'),
    );
  });

  test('ask сразу возвращает id; ответ кнопкой приходит событием', async () => {
    const r = await client.callTool({
      name: 'ask',
      arguments: {
        text: 'Какую БД?',
        options: [
          { id: 'A', text: 'SQLite' },
          { id: 'B', text: 'Postgres' },
        ],
      },
    });
    const id = text(r).match(/q_[0-9a-z]+/)?.[0];
    expect(id).toBeString();
    const question = fake.sent.findLast((m) => FakeBotApi.plainText(m.params).includes('Какую БД?'))!;

    fake.pushUpdate({
      callback_query: { id: 'cb1', data: `a:${id}:B`, message: { message_id: question.messageId, chat: { id: NUR } } },
    });
    await until(() => events.some((e) => (e.params?.meta as Record<string, string>)?.question_id === id));
    const answer = events.find((e) => (e.params?.meta as Record<string, string>)?.question_id === id);
    expect(answer?.params?.meta).toMatchObject({ kind: 'answer', question_id: id, option: 'B' });
  });
});
