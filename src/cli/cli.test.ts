import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from '../app/agent.ts';
import { HumanService } from '../app/human.ts';
import { FakeTelegram } from '../app/telegram.fake.ts';
import { NUR_CHAT, SeqIds } from '../app/testkit.fake.ts';
import { Waiter } from '../app/waiter.ts';
import { Access } from '../domain/access.ts';
import { HttpApi } from '../http/api.ts';
import { SqliteStore } from '../infra/sqlite-store.ts';
import { SystemClock } from '../infra/system.ts';
import { Cli } from './cli.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function setup() {
  const clock = new SystemClock();
  const telegram = new FakeTelegram();
  const deps = {
    store: SqliteStore.open(':memory:'),
    telegram,
    access: Access.parse('nur:t-nur', `nur:${NUR_CHAT}`),
    clock,
    ids: new SeqIds(),
    waiter: new Waiter(clock),
    timeZone: 'Asia/Oral',
  };
  const human = new HumanService(deps);
  const server = new HttpApi({ agent: new AgentService(deps), access: deps.access, maxWaitMs: 40 }).listen({
    port: 0,
    hostname: '127.0.0.1',
  });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'herald-cli-')));
  cleanup.push(
    () => server.stop(true),
    () => rmSync(cwd, { recursive: true, force: true }),
  );
  const env = {
    HERALD_CONFIG: join(cwd, 'нет.json'),
    HERALD_URL: `http://127.0.0.1:${server.port}`,
    HERALD_TOKEN: 't-nur',
    HERALD_HOST: 'laptop',
  };

  const run = async (args: string[], extraEnv: Record<string, string> = {}) => {
    let stdout = '';
    let stderr = '';
    const code = await new Cli({
      env: { ...env, ...extraEnv },
      cwd,
      clock,
      out: (s) => {
        stdout += s;
      },
      err: (s) => {
        stderr += s;
      },
    }).run(args);
    return {
      code,
      stdout,
      stderr,
      json: stdout.startsWith('{') || stdout.startsWith('[') ? JSON.parse(stdout) : undefined,
    };
  };

  let updateId = 0;
  const lastMessage = () => telegram.last(NUR_CHAT)!;
  const press = (data: string) =>
    human.handle({
      kind: 'callback',
      updateId: ++updateId,
      callbackId: `cb${updateId}`,
      chatId: NUR_CHAT,
      messageId: lastMessage().messageId,
      data,
    });
  const reply = (text: string, replyTo = lastMessage().messageId) =>
    human.handle({ kind: 'message', updateId: ++updateId, chatId: NUR_CHAT, messageId: 900 + updateId, text, replyTo });
  /** Дождаться сообщения вопроса в Telegram. */
  const asked = async () => {
    for (let i = 0; i < 200 && !lastMessage()?.buttons && !lastMessage()?.text.includes('?'); i++) await Bun.sleep(5);
    return lastMessage();
  };
  return { cwd, telegram, run, press, reply, asked };
}

describe('herald notify / status', () => {
  test('notify: текст из аргументов, JSON {ok}, код 0; шапка — каталог (вне git)', async () => {
    const k = setup();
    const r = await k.run(['notify', 'Фаза', 'готова']);
    expect(r).toMatchObject({ code: 0, json: { ok: true } });
    const project = k.cwd.split('/').at(-1);
    expect(k.telegram.last(NUR_CHAT)?.text).toBe(`[laptop · ${project}]\nФаза готова`);
  });

  test('--session и HERALD_SESSION задают имя сессии', async () => {
    const k = setup();
    await k.run(['notify', '--session', 'ночь', 'x']);
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('[laptop · ночь]\nx');
    await k.run(['notify', 'y'], { HERALD_SESSION: 'день' });
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('[laptop · день]\ny');
  });

  test('title — название сессии в шапке; CLAUDE_CODE_SESSION_ID — окно сессии', async () => {
    const k = setup();
    const env = { CLAUDE_CODE_SESSION_ID: '02dcbdb9-11eb' };
    expect((await k.run(['title', 'ревью', 'Ф4'], env)).json).toEqual({ ok: true });
    await k.run(['notify', 'x'], env);
    const project = k.cwd.split('/').at(-1);
    expect(k.telegram.last(NUR_CHAT)?.text).toBe(`[laptop · ${project}·02dc · ревью Ф4]\nx`);
  });

  test('PI_SESSION_ID (bash pi) — окно сессии, как у Claude Code', async () => {
    const k = setup();
    await k.run(['notify', 'x'], { PI_SESSION_ID: '019a7c3e-55aa' });
    const project = k.cwd.split('/').at(-1);
    expect(k.telegram.last(NUR_CHAT)?.text).toBe(`[laptop · ${project}·019a]\nx`);
  });

  test('status — без отправки в Telegram', async () => {
    const k = setup();
    expect((await k.run(['status', 'Фаза 4: CLI'])).code).toBe(0);
    expect(k.telegram.sentTo(NUR_CHAT)).toEqual([]);
  });

  test('ошибка доставки — код 1, текст в stderr (КП 1)', async () => {
    const k = setup();
    k.telegram.failNext('бот заблокирован');
    const r = await k.run(['notify', 'x']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('бот заблокирован');
  });
});

describe('herald ask', () => {
  test('ответ кнопкой — JSON с вариантом и текстом, код 0 (КП 2)', async () => {
    const k = setup();
    const running = k.run([
      'ask',
      'Какую БД?',
      '-o',
      'A: SQLite',
      '-o',
      'B: Postgres',
      '--recommended',
      'A',
      '--timeout',
      '600',
    ]);
    const msg = await k.asked();
    expect(msg.text).toContain('На раздумье 10 мин');
    expect(msg.buttons?.flat().map((b) => b.text)).toContain('Жди меня');
    const id = msg.buttons![0]![0]!.data.split(':')[1];
    await k.press(`a:${id}:B`);
    expect(await running).toMatchObject({
      code: 0,
      json: { id, status: 'answered', by: 'human', option: 'B', text: 'Postgres' },
    });
  });

  test('reply — свободный текст', async () => {
    const k = setup();
    const running = k.run(['ask', 'Как назвать?']);
    await k.asked();
    await k.reply('herald');
    expect((await running).json).toMatchObject({ status: 'answered', text: 'herald' });
  });

  test('--timeout истёк — status timeout, код 2', async () => {
    const k = setup();
    const r = await k.run(['ask', 'БД?', '-o', 'A: SQLite', '--timeout', '0']);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ status: 'timeout' });
    expect(r.json.id).toBeString();
  });

  test('без --timeout ждёт дольше одного long poll; в сообщении — время не ограничено, «Жди меня» нет', async () => {
    const k = setup();
    const running = k.run(['ask', 'Как назвать?', '-o', 'A: herald']);
    const msg = await k.asked();
    expect(msg.text).toContain('Время не ограничено');
    expect(msg.buttons?.flat().map((b) => b.text)).not.toContain('Жди меня');
    await Bun.sleep(200);
    await k.reply('herald');
    expect((await running).code).toBe(0);
  });

  test('неверный вариант (без «:»), рекомендованный не из вариантов — код 1', async () => {
    const k = setup();
    expect((await k.run(['ask', 'БД?', '-o', 'SQLite'])).stderr).toContain('«id: текст»');
    expect((await k.run(['ask', 'БД?', '-o', 'A: SQLite', '--recommended', 'B'])).code).toBe(1);
  });
});

describe('herald decide', () => {
  test('вариант с причиной — JSON вопроса, сообщение обновлено (КП 3)', async () => {
    const k = setup();
    const id = (await k.run(['ask', 'БД?', '-o', 'A: SQLite', '--timeout', '0'])).json.id;
    const r = await k.run(['decide', id, 'A', '--reason', 'по таймауту']);
    expect(r).toMatchObject({ code: 0, json: { id, status: 'decided', by: 'agent', option: 'A', text: 'SQLite' } });
    expect(k.telegram.edits.at(-1)?.text).toContain('по таймауту');
  });

  test('--text вместо варианта; без --reason — код 1', async () => {
    const k = setup();
    const id = (await k.run(['ask', 'Имя?', '--timeout', '0'])).json.id;
    expect((await k.run(['decide', id, '--reason', 'r'])).code).toBe(1);
    expect((await k.run(['decide', id, '--text', 'herald'])).code).toBe(1);
    expect((await k.run(['decide', id, '--text', 'herald', '--reason', 'по таймауту'])).json).toMatchObject({
      text: 'herald',
    });
  });
});

describe('herald answered', () => {
  test('ответ человека в терминале — JSON как у ask, сообщение без кнопок', async () => {
    const k = setup();
    const id = (await k.run(['ask', 'БД?', '-o', 'A: SQLite', '-o', 'B: Postgres', '--timeout', '0'])).json.id;
    const r = await k.run(['answered', id, 'B']);
    expect(r).toMatchObject({ code: 0, json: { id, status: 'answered', by: 'human', option: 'B', text: 'Postgres' } });
    expect(k.telegram.edits.at(-1)).toMatchObject({ buttons: [] });
    expect(k.telegram.edits.at(-1)?.text).toContain('(в терминале)');
  });

  test('--text вместо варианта; без варианта и текста — код 1', async () => {
    const k = setup();
    const id = (await k.run(['ask', 'Имя?', '--timeout', '0'])).json.id;
    expect((await k.run(['answered', id])).code).toBe(1);
    expect((await k.run(['answered', id, '--text', 'herald'])).json).toMatchObject({ text: 'herald' });
  });
});

describe('herald inbox / ack', () => {
  test('указание и поздний ответ; --ack подтверждает выданное', async () => {
    const k = setup();
    const id = (await k.run(['ask', 'БД?', '-o', 'A: SQLite', '--timeout', '0'])).json.id;
    await k.run(['decide', id, 'A', '--reason', 'по таймауту']);
    await k.press(`a:${id}:A`);
    await k.run(['notify', 'готово']);
    await k.reply('Займись тестами');

    const r = await k.run(['inbox', '--ack']);
    expect(r.code).toBe(0);
    expect(r.json.map((i: { kind: string }) => i.kind)).toEqual(['late-answer', 'directive']);
    expect((await k.run(['inbox'])).json).toEqual([]);
  });

  test('--wait ждёт первых; ack <id…>', async () => {
    const k = setup();
    await k.run(['notify', 'готово']);
    const notice = k.telegram.last(NUR_CHAT)!.messageId;
    const running = k.run(['inbox', '--wait', '5']);
    await Bun.sleep(100);
    await k.reply('Тесты', notice);
    const items = (await running).json;
    expect(items).toHaveLength(1);
    expect((await k.run(['ack', items[0].id])).json).toEqual({ read: [items[0].id] });
  });
});

describe('Ошибки использования и доступа', () => {
  test('без команды и неизвестная — usage в stderr, код 1; help — код 0', async () => {
    const k = setup();
    const none = await k.run([]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('herald ask');
    expect((await k.run(['nope'])).code).toBe(1);
    const help = await k.run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('herald ask');
  });

  test('пустой текст notify — код 1', async () => {
    const k = setup();
    expect((await k.run(['notify'])).code).toBe(1);
  });

  test('неверный токен — код 1 (КП 7)', async () => {
    const k = setup();
    const r = await k.run(['notify', 'x'], { HERALD_TOKEN: 't-unknown' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('токен');
  });

  test('нет настроек — код 1 с подсказкой', async () => {
    const k = setup();
    const r = await k.run(['notify', 'x'], { HERALD_URL: '' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('serverUrl');
  });
});
