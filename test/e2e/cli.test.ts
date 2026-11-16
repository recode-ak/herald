/**
 * Сквозные сценарии CLI: процесс `herald` → HTTP → HeraldServer (SQLite, сценарии, адаптер и опрос Telegram)
 * → локальный фейк Bot API. Человек — апдейты, положенные в фейк. КП 1–5, 7 spec трека herald-v1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBotApi } from '../../src/infra/bot-api.fake.ts';
import { ServerConfig } from '../../src/server/config.ts';
import { HeraldServer } from '../../src/server/herald-server.ts';

const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');
const NUR = 111;
const STRANGER = 999;

let fake: FakeBotApi;
let server: HeraldServer;
let cwd: string;
let userMessageId = 10_000;

beforeAll(() => {
  fake = new FakeBotApi();
  cwd = mkdtempSync(join(tmpdir(), 'herald-e2e-'));
  server = HeraldServer.start(
    ServerConfig.fromEnv({
      HERALD_TOKENS: 'nur:t-nur,ann:t-ann',
      HERALD_PEOPLE: `nur:${NUR},ann:222`,
      HERALD_BOT_TOKEN: fake.token,
      HERALD_TELEGRAM_API: fake.baseUrl,
      HERALD_PORT: '0',
      HERALD_DB: ':memory:',
      HERALD_MAX_WAIT_SECONDS: '1',
    }),
    { log: () => {} },
  );
});

afterAll(async () => {
  await server.stop();
  fake.stop();
  rmSync(cwd, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON вывода CLI проверяется по полям в тестах
  json: any;
}

/** Запустить `herald` отдельным процессом. */
async function herald(args: string[], token = 't-nur'): Promise<Run> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      HERALD_URL: server.url.href.replace(/\/$/, ''),
      HERALD_TOKEN: token,
      HERALD_HOST: 'laptop',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr, json: /^[[{]/.test(stdout) ? JSON.parse(stdout) : undefined };
}

type Sent = (typeof fake.sent)[number];

/** Дождаться отправленного ботом сообщения, подходящего под условие. */
async function sent(match: (m: Sent) => boolean): Promise<Sent> {
  for (let i = 0; i < 400; i++) {
    const found = fake.sent.findLast(match);
    if (found) return found;
    await Bun.sleep(5);
  }
  throw new Error('бот не отправил ожидаемое сообщение');
}

const textOf = (m: Sent) => String(m.params.text);
const buttonsOf = (m: Sent) =>
  (
    (m.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }) ?? {
      inline_keyboard: [],
    }
  ).inline_keyboard.flat();

/** Человек пишет боту (reply — на message_id). */
function say(text: string, replyTo?: number, chatId = NUR): void {
  fake.pushUpdate({
    message: {
      message_id: ++userMessageId,
      chat: { id: chatId },
      text,
      ...(replyTo !== undefined && { reply_to_message: { message_id: replyTo } }),
    },
  });
}

/** Человек нажимает кнопку сообщения. */
function press(message: Sent, buttonText: string): void {
  const button = buttonsOf(message).find((b) => b.text.startsWith(buttonText));
  if (!button) throw new Error(`нет кнопки «${buttonText}»`);
  fake.pushUpdate({
    callback_query: {
      id: `cb${++userMessageId}`,
      data: button.callback_data,
      message: { message_id: message.messageId, chat: { id: NUR } },
    },
  });
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(5);
  expect(cond()).toBe(true);
}

describe('КП 1: notify', () => {
  test('доставляет сообщение с шапкой; при ошибке — ненулевой код', async () => {
    const ok = await herald(['notify', '--session', 'kp1', 'Фаза готова']);
    expect(ok.code).toBe(0);
    await sent((m) => textOf(m) === '[laptop · kp1]\nФаза готова');

    fake.failNext('sendMessage', {
      status: 403,
      body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    });
    const failed = await herald(['notify', '--session', 'kp1', 'не дойдёт']);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('bot was blocked by the user');
  });
});

describe('КП 2: ask', () => {
  test('возвращает вариант, выбранный кнопкой', async () => {
    const running = herald(['ask', '--session', 'kp2', 'Какую БД?', '-o', 'A: SQLite', '-o', 'B: Postgres']);
    const question = await sent((m) => textOf(m).includes('Какую БД?'));
    press(question, 'B');
    const r = await running;
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'answered', by: 'human', option: 'B', text: 'Postgres' });
  });

  test('возвращает текст reply', async () => {
    const running = herald(['ask', '--session', 'kp2', 'Как назвать сервис?']);
    const question = await sent((m) => textOf(m).includes('Как назвать сервис?'));
    say('herald', question.messageId);
    expect((await running).json).toMatchObject({ status: 'answered', text: 'herald' });
  });

  test('по таймауту — «нет ответа», код 2', async () => {
    const r = await herald(['ask', '--session', 'kp2', 'Подождёшь?', '-o', 'A: да', '--timeout', '1']);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ status: 'timeout' });
  });
});

describe('КП 3: decide и поздний ответ', () => {
  test('decide обновляет сообщение; поздний ответ доставляется сессии', async () => {
    const asked = await herald([
      'ask',
      '--session',
      'kp3',
      'Порт?',
      '-o',
      'A: 4518',
      '-o',
      'B: 4519',
      '--timeout',
      '0',
    ]);
    expect(asked.code).toBe(2);
    const question = await sent((m) => textOf(m).includes('Порт?'));

    const decided = await herald(['decide', '--session', 'kp3', asked.json.id, 'A', '--reason', 'по таймауту']);
    expect(decided.json).toMatchObject({ status: 'decided', by: 'agent', option: 'A' });
    const edit = fake.callsOf('editMessageText').findLast((p) => p.message_id === question.messageId);
    expect(String(edit?.text)).toContain('по таймауту');

    press(question, 'B');
    await until(() => fake.callsOf('answerCallbackQuery').length > 0);
    const inbox = await herald(['inbox', '--session', 'kp3', '--wait', '5']);
    expect(inbox.json).toMatchObject([{ kind: 'late-answer', questionId: asked.json.id, option: 'B' }]);
  });
});

describe('КП 4: /status и /sessions без участия агента', () => {
  test('бот отвечает последним статусом и списком сессий', async () => {
    expect((await herald(['status', '--session', 'kp4', 'Фаза 4: CLI'])).code).toBe(0);
    say('/status');
    await sent((m) => textOf(m).includes('kp4 — Фаза 4: CLI'));

    say('/sessions');
    const menu = await sent((m) => buttonsOf(m).some((b) => b.text.startsWith('kp4 ·')));
    expect(textOf(menu)).toContain('Фаза 4: CLI');
  });
});

describe('КП 5: указания только нужной сессии; отметки «в ящике» и «прочитано»', () => {
  test('reply на сообщение сессии', async () => {
    await herald(['notify', '--session', 'alpha', 'Готова альфа']);
    await herald(['notify', '--session', 'beta', 'Готова бета']);
    const alphaNotice = await sent((m) => textOf(m).endsWith('Готова альфа'));

    say('Альфа, займись тестами', alphaNotice.messageId);
    await sent((m) => textOf(m) === '📥 в ящике сессии alpha');

    const alpha = await herald(['inbox', '--session', 'alpha', '--wait', '5', '--ack']);
    expect(alpha.json).toMatchObject([{ kind: 'directive', text: 'Альфа, займись тестами' }]);
    expect((await herald(['inbox', '--session', 'beta'])).json).toEqual([]);
    await until(() => fake.callsOf('editMessageText').some((p) => p.text === '✅ прочитано агентом · сессия alpha'));
  });

  test('выбор сессии в /sessions, затем текст', async () => {
    await herald(['notify', '--session', 'gamma', 'Готова гамма']);
    say('/sessions');
    const menu = await sent((m) => buttonsOf(m).some((b) => b.text.startsWith('gamma ·')));
    press(menu, 'gamma ·');
    await sent((m) => textOf(m).includes('указание сессии gamma'));
    say('Гамма, обнови доки');

    const gamma = await herald(['inbox', '--session', 'gamma', '--wait', '5']);
    expect(gamma.json).toMatchObject([{ kind: 'directive', text: 'Гамма, обнови доки' }]);
    expect((await herald(['inbox', '--session', 'alpha'])).json).toEqual([]);
  });
});

describe('КП 7: доступ', () => {
  test('чужой chat_id игнорируется', async () => {
    say('/status', undefined, STRANGER);
    say('/sessions');
    await sent((m) => buttonsOf(m).length > 0 && m.params.chat_id === NUR);
    expect(fake.sent.some((m) => m.params.chat_id === STRANGER)).toBe(false);
  });

  test('неверный токен — код 1; чужой вопрос — код 1', async () => {
    const wrong = await herald(['notify', 'x'], 't-unknown');
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('токен');

    const asked = await herald(['ask', '--session', 'kp7', 'Чей?', '-o', 'A: мой', '--timeout', '0']);
    const foreign = await herald(['decide', '--session', 'kp7', asked.json.id, 'A', '--reason', 'r'], 't-ann');
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toContain('другого человека');
  });
});
