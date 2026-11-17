import { describe, expect, test } from 'bun:test';
import { Session } from '../domain/session.ts';
import { AgentService } from './agent.ts';
import { HumanService } from './human.ts';
import type { TelegramUpdate } from './telegram.ts';
import { ANN_CHAT, ann, NUR_CHAT, nur, testkit } from './testkit.fake.ts';

const nurKey = Session.keyOf(nur.session);
const ops = { ...nur, session: { host: 'server', root: '/srv/chronicle' } };
const db = {
  text: 'Какую БД?',
  options: [
    { id: 'A', text: 'SQLite' },
    { id: 'B', text: 'Postgres' },
  ],
  recommended: 'A',
  timeoutMs: 180_000,
};

function setup() {
  const kit = testkit();
  let updateId = 0;
  const human = new HumanService(kit);
  return {
    ...kit,
    agent: new AgentService(kit),
    human,
    /** Нажатие кнопки на сообщении. */
    press: (chatId: number, messageId: number, data: string) =>
      human.handle({ kind: 'callback', updateId: ++updateId, callbackId: `cb${updateId}`, chatId, messageId, data }),
    /** Текст человека; `replyTo` — reply на сообщение. */
    say: (chatId: number, text: string, replyTo?: number) => {
      const update: TelegramUpdate = {
        kind: 'message',
        updateId: ++updateId,
        chatId,
        messageId: 1000 + updateId,
        text,
      };
      return human.handle(replyTo === undefined ? update : { ...update, replyTo });
    },
  };
}

describe('Ответы на вопрос', () => {
  test('кнопка варианта → ответ во входящих, сообщение обновлено; отдельной отметки нет', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const qMsg = k.telegram.last(NUR_CHAT)!;

    await k.press(NUR_CHAT, qMsg.messageId, `a:${q.id}:B`);

    expect(k.store.question(q.id)?.status).toBe('answered');
    const [item] = await k.agent.inbox(nur);
    expect(item?.toState()).toMatchObject({ kind: 'answer', questionId: q.id, option: 'B', text: 'B: Postgres' });
    expect(k.telegram.message(NUR_CHAT, qMsg.messageId)?.text).toEndWith('\n\n👤 Принят B.');
    expect(k.telegram.callbackAnswers.at(-1)).toEqual({ callbackId: 'cb1', text: 'Принят B' });

    expect(k.telegram.sentTo(NUR_CHAT)).toHaveLength(1);
    expect(k.telegram.reactions).toEqual([]);
  });

  test('reply на вопрос → свободный ответ', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    await k.say(NUR_CHAT, 'возьми Postgres, но позже', k.telegram.last(NUR_CHAT)!.messageId);

    expect(k.store.question(q.id)?.resolution).toMatchObject({ by: 'human', text: 'возьми Postgres, но позже' });
    const [item] = await k.agent.inbox(nur);
    expect(item?.toState()).toMatchObject({ kind: 'answer', questionId: q.id, text: 'возьми Postgres, но позже' });
    expect(item?.option).toBeUndefined();
    expect(k.telegram.sentTo(NUR_CHAT)).toHaveLength(1);
    expect(k.telegram.reaction(NUR_CHAT, 1001)).toBe('✍');
    expect(k.store.link(NUR_CHAT, 1001)).toMatchObject({ sessionKey: nurKey, inboxId: item!.id });
  });

  test('ответ после decide → late-answer, первое решение сохранено', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const qMsg = k.telegram.last(NUR_CHAT)!;
    await k.agent.decide(nur, q.id, { option: 'A' }, 'по таймауту');

    await k.press(NUR_CHAT, qMsg.messageId, `a:${q.id}:B`);

    const stored = k.store.question(q.id)!;
    expect(stored.status).toBe('decided');
    expect(stored.resolution?.option).toBe('A');
    const [item] = await k.agent.inbox(nur);
    expect(item?.toState()).toMatchObject({ kind: 'late-answer', questionId: q.id, option: 'B' });
    expect(k.telegram.message(NUR_CHAT, qMsg.messageId)?.text).toEndWith('\n🔁 Переигрывание: Принят B.');
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe(`Переигрывание вопроса ${q.id}: B`);
  });

  test('«Жди меня» — агенту решать нельзя, в сообщении пометка', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const qMsg = k.telegram.last(NUR_CHAT)!;
    await k.press(NUR_CHAT, qMsg.messageId, `h:${q.id}`);

    expect(k.store.question(q.id)?.heldAt).toBeDefined();
    expect(k.telegram.message(NUR_CHAT, qMsg.messageId)?.text).toEndWith('⏸ Агент ждёт твоего ответа.');
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('Агент подождёт');
    await expect(k.agent.decide(nur, q.id, { option: 'A' }, 'по таймауту')).rejects.toThrow('просил ждать');
  });

  test('кнопки по состоянию: открыт — варианты и «Жди меня»; удержан или решён агентом — варианты; ответил человек — нет', async () => {
    const k = setup();
    const texts = (messageId: number) =>
      (k.telegram.message(NUR_CHAT, messageId)?.buttons ?? []).flat().map((b) => b.text);
    const answered = await k.agent.ask(nur, db);
    const aMsg = k.telegram.last(NUR_CHAT)!.messageId;
    const decided = await k.agent.ask(nur, db);
    const dMsg = k.telegram.last(NUR_CHAT)!.messageId;
    const held = await k.agent.ask(nur, db);
    const hMsg = k.telegram.last(NUR_CHAT)!.messageId;
    expect(texts(hMsg)).toEqual(['A ⭐', 'B', 'Жди меня', '🖥 В терминал']);

    await k.press(NUR_CHAT, aMsg, `a:${answered.id}:B`);
    await k.agent.decide(nur, decided.id, { option: 'A' }, 'по таймауту');
    await k.press(NUR_CHAT, hMsg, `h:${held.id}`);

    expect(texts(aMsg)).toEqual([]);
    expect(texts(dMsg)).toEqual(['A ⭐', 'B']);
    expect(texts(hMsg)).toEqual(['A ⭐', 'B', '🖥 В терминал']);

    await k.press(NUR_CHAT, dMsg, `a:${decided.id}:B`);
    expect(texts(dMsg)).toEqual([]);
    expect(k.telegram.message(NUR_CHAT, dMsg)?.text).not.toContain('Кнопки — чтобы переиграть');
  });

  test('«Жди меня» — агенту входящее hold (один раз): решать нельзя, жди ответа', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const qMsg = k.telegram.last(NUR_CHAT)!;
    await k.press(NUR_CHAT, qMsg.messageId, `h:${q.id}`);
    await k.press(NUR_CHAT, qMsg.messageId, `h:${q.id}`);
    const items = await k.agent.inbox(nur);
    expect(items.map((i) => i.toState())).toMatchObject([{ kind: 'hold', questionId: q.id }]);
    expect(items[0]?.text).toBe(
      `Человек нажал «Жди меня» на вопросе ${q.id}: решать самому нельзя — жди его ответа без срока.`,
    );
  });

  test('«Жди меня» на решённом вопросе (старая кнопка) — подсказка, без ошибки', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    await k.agent.decide(nur, q.id, { option: 'A' }, 'по таймауту');
    await k.press(NUR_CHAT, k.telegram.last(NUR_CHAT)!.messageId, `h:${q.id}`);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe(`⚠️ вопрос ${q.id} уже решён`);
  });
});

const trio = {
  items: [
    {
      text: 'База?',
      options: [
        { id: 'A', text: 'SQLite' },
        { id: 'B', text: 'JSON' },
      ],
      recommended: 'A',
    },
    { text: 'Порт?', options: [] },
    {
      text: 'Логи?',
      options: [
        { id: 'A', text: 'stderr' },
        { id: 'B', text: 'файл' },
      ],
      recommended: 'B',
    },
  ],
  timeoutMs: 180_000,
};

describe('Пачка вопросов', () => {
  const buttons = (k: ReturnType<typeof setup>, messageId: number) =>
    (k.telegram.message(NUR_CHAT, messageId)?.buttons ?? []).flat().map((b) => b.text);

  test('пункты по одному: ответ → следующий новым сообщением; все ответы — одним answer', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, trio);
    expect(k.telegram.sentTo(NUR_CHAT)).toHaveLength(1);
    const m1 = k.telegram.last(NUR_CHAT)!;
    expect(m1.text).toContain('Вопрос 1 из 3');

    await k.press(NUR_CHAT, m1.messageId, `b:${q.id}:1:B`);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('Принят B · дальше вопрос 2 из 3');
    expect(buttons(k, m1.messageId)).toEqual([]);
    expect(await k.agent.inbox(nur)).toEqual([]);
    const m2 = k.telegram.last(NUR_CHAT)!;
    expect(m2.messageId).not.toBe(m1.messageId);
    expect(m2.text).toContain('Вопрос 2 из 3');

    await k.say(NUR_CHAT, '4518', m2.messageId);
    const m3 = k.telegram.last(NUR_CHAT)!;
    expect(m3.text).toContain('Вопрос 3 из 3');
    expect(k.telegram.reactions).toEqual([]);

    await k.press(NUR_CHAT, m3.messageId, `b:${q.id}:3:A`);
    expect(k.store.question(q.id)?.status).toBe('answered');
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('Принят A');
    const items = await k.agent.inbox(nur);
    expect(items.map((i) => i.toState())).toMatchObject([
      { kind: 'answer', questionId: q.id, text: '1. База? — B: JSON\n2. Порт? — 4518\n3. Логи? — A: stderr' },
    ]);
    expect(items[0]?.option).toBeUndefined();
    expect(k.telegram.sentTo(NUR_CHAT)).toHaveLength(3);
  });

  test('«Жди меня (вся пачка)» — весь вопрос удержан, пометка на текущем пункте; агенту решать нельзя', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, trio);
    const m1 = k.telegram.last(NUR_CHAT)!;
    expect(buttons(k, m1.messageId)).toEqual(['A ⭐', 'B', 'Жди меня (вся пачка)', '🖥 В терминал']);
    await k.press(NUR_CHAT, m1.messageId, `h:${q.id}`);
    expect(k.telegram.message(NUR_CHAT, m1.messageId)?.text).toEndWith('⏸ Агент ждёт твоего ответа.');
    await k.press(NUR_CHAT, m1.messageId, `b:${q.id}:1:A`);
    expect(k.telegram.last(NUR_CHAT)?.text).toEndWith('⏸ Агент ждёт твоего ответа.');
    await expect(k.agent.decide(nur, q.id, [], 'по таймауту')).rejects.toThrow('просил ждать');
  });

  test('«🖥 В терминал»: кнопки сняты, следующие не приходят, агенту to-terminal (один раз); reply принимается', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, trio);
    const m1 = k.telegram.last(NUR_CHAT)!;
    await k.press(NUR_CHAT, m1.messageId, `b:${q.id}:1:B`);
    const m2 = k.telegram.last(NUR_CHAT)!;

    await k.press(NUR_CHAT, m2.messageId, `t:${q.id}`);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('Переведено в терминал');
    expect(k.store.question(q.id)?.terminalAt).toBeDefined();
    const after = k.telegram.message(NUR_CHAT, m2.messageId)!;
    expect(after.text).toEndWith('🖥 Переведено в терминал — ответь там; reply здесь тоже примется.');
    expect(after.buttons ?? []).toEqual([]);
    const [item] = await k.agent.inbox(nur);
    expect(item?.toState()).toMatchObject({ kind: 'to-terminal', questionId: q.id });
    expect(item?.text).toContain('2. Порт? — свободный ответ');

    await k.press(NUR_CHAT, m2.messageId, `t:${q.id}`);
    expect(await k.agent.inbox(nur)).toHaveLength(1);

    await k.say(NUR_CHAT, '80', m2.messageId);
    expect(k.store.question(q.id)?.items[1]?.resolution?.text).toBe('80');
    expect(k.telegram.sentTo(NUR_CHAT)).toHaveLength(2);
  });

  test('решение агента: текущий пункт — 🤖 и кнопки; неотправленные — итоговым сообщением, reply на него — указание', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, trio);
    const m1 = k.telegram.last(NUR_CHAT)!;
    await k.press(NUR_CHAT, m1.messageId, `b:${q.id}:1:B`);
    const m2 = k.telegram.last(NUR_CHAT)!;

    await k.agent.decide(nur, q.id, [{ item: 2, choice: { text: '80' } }], 'по таймауту');
    expect(k.telegram.message(NUR_CHAT, m2.messageId)?.text).toEndWith(
      '🤖 Принято «80» по таймауту. Кнопки — чтобы переиграть.',
    );
    const rest = k.telegram.last(NUR_CHAT)!;
    expect(rest.text).toContain('🤖 Агент решил по таймауту остальные вопросы:\n3. Логи? — B: файл');
    expect(k.telegram.sentTo(NUR_CHAT)).toHaveLength(3);

    await k.say(NUR_CHAT, 'логи лучше в stderr', rest.messageId);
    expect((await k.agent.inbox(nur)).map((i) => i.toState())).toMatchObject([
      { kind: 'directive', text: 'логи лучше в stderr' },
    ]);
  });

  test('ответ на пункт решённого вопроса — поздний этого пункта', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, trio);
    const m1 = k.telegram.last(NUR_CHAT)!;
    await k.agent.decide(nur, q.id, [{ item: 2, choice: { text: '80' } }], 'по таймауту');
    await k.press(NUR_CHAT, m1.messageId, `b:${q.id}:1:B`);
    const [item] = await k.agent.inbox(nur);
    expect(item?.toState()).toMatchObject({
      kind: 'late-answer',
      questionId: q.id,
      option: 'B',
      text: '1. База? — B: JSON',
    });
  });
});

describe('Сессия не на связи — предупреждение', () => {
  test('указание: реакция и reply «прочтёт, когда подключится»; на связи — без предупреждения', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    const notice = k.telegram.last(NUR_CHAT)!.messageId;
    await k.say(NUR_CHAT, 'раз', notice);
    expect(k.telegram.sentTo(NUR_CHAT)).toHaveLength(1);

    k.clock.advance(5 * 60_000);
    await k.say(NUR_CHAT, 'два', notice);
    expect(k.telegram.reaction(NUR_CHAT, 1002)).toBe('✍');
    expect(k.telegram.last(NUR_CHAT)).toMatchObject({
      text: '⚠️ u7-school не на связи (5 мин назад) — прочтёт, когда подключится.',
      replyTo: 1002,
    });
  });

  test('ответ кнопкой закрытой сессии — предупреждение во всплывающем ответе', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const qMsg = k.telegram.last(NUR_CHAT)!.messageId;
    await k.agent.bye(nur);
    await k.press(NUR_CHAT, qMsg, `a:${q.id}:B`);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('Принят B · ⚠️ u7-school не на связи (закрыта только что)');
  });
});

describe('Указания', () => {
  test('reply на уведомление сессии → указание этой сессии', async () => {
    const k = setup();
    await k.agent.notify(nur, 'Фаза 2 готова');
    await k.agent.notify(ops, 'бэкап сделан');
    const nurMsg = k.telegram.sentTo(NUR_CHAT)[0]!;

    await k.say(NUR_CHAT, 'не трогай миграции', nurMsg.messageId);

    expect((await k.agent.inbox(nur)).map((i) => [i.kind, i.text])).toEqual([['directive', 'не трогай миграции']]);
    expect(await k.agent.inbox(ops)).toEqual([]);
    expect(k.telegram.sentTo(NUR_CHAT)).toHaveLength(2);
    expect(k.telegram.reaction(NUR_CHAT, 1001)).toBe('✍');
  });

  test('reply на своё указание — тоже указание той же сессии', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    await k.say(NUR_CHAT, 'раз', k.telegram.last(NUR_CHAT)!.messageId);
    await k.say(NUR_CHAT, 'два', 1001);
    expect((await k.agent.inbox(nur)).map((i) => i.text)).toEqual(['раз', 'два']);
  });

  test('/sessions → кнопка сессии → следующий текст — её указание (один раз)', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    await k.agent.notify(ops, 'y');

    await k.say(NUR_CHAT, '/sessions');
    const menu = k.telegram.last(NUR_CHAT)!;
    const opsButton = menu.buttons!.flat().find((b) => b.text.includes('chronicle'))!;
    await k.press(NUR_CHAT, menu.messageId, opsButton.data);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('Адресат: chronicle');

    await k.say(NUR_CHAT, 'перезапусти pm2');
    expect((await k.agent.inbox(ops)).map((i) => i.text)).toEqual(['перезапусти pm2']);
    expect(await k.agent.inbox(nur)).toEqual([]);

    await k.say(NUR_CHAT, 'ещё');
    expect(await k.agent.inbox(ops)).toHaveLength(1);
    expect(k.telegram.last(NUR_CHAT)?.text).toStartWith('Кому?');
  });

  test('текст без reply и без адресата — подсказка, во входящие не попадает', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    await k.say(NUR_CHAT, 'привет');
    expect(await k.agent.inbox(nur)).toEqual([]);
    expect(k.telegram.last(NUR_CHAT)?.text).toStartWith('Кому?');
  });

  test('reply на сообщение, не связанное с сессией, — подсказка', async () => {
    const k = setup();
    await k.say(NUR_CHAT, 'что это', 999);
    expect(k.telegram.last(NUR_CHAT)?.text).toStartWith('Кому?');
  });
});

describe('/sessions и /status', () => {
  test('/sessions — только сессии на связи, со статусом, недавние первыми; закрытые и молчащие не видны', async () => {
    const k = setup();
    const herald = { ...nur, session: { host: 'laptop', root: '/home/nur/dev/herald' } };
    const old = { ...nur, session: { host: 'laptop', root: '/home/nur/dev/old' } };
    await k.agent.status(ops, 'бэкап');
    await k.agent.notify(old, 'x');
    await k.agent.bye(old);
    k.clock.advance(Session.ONLINE_MS);
    await k.agent.status(nur, 'Фаза 2: сценарии');
    k.clock.advance(60_000);
    await k.agent.notify(herald, 'x');

    await k.say(NUR_CHAT, '/sessions');
    const menu = k.telegram.last(NUR_CHAT)!;
    expect(menu.text).toBe(
      [
        'Сессии на связи:',
        '',
        '🟢 herald',
        'laptop · статуса нет',
        '',
        '🟢 u7-school',
        'laptop · 1 мин назад',
        'Фаза 2: сценарии',
        '',
        'Выбери адресата указания или команды (/clear, /compact, /exit).',
      ].join('\n'),
    );
    expect(menu.buttons!.map((row) => row.map((b) => b.text))).toEqual([['herald · laptop'], ['u7-school · laptop']]);
    for (const b of menu.buttons!.flat()) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(64);
  });

  test('/sessions в HTML: имя жирным, машина и давность курсивом, статус — Markdown агента', async () => {
    const k = setup();
    await k.agent.title(nur, 'dmg <ui>');
    await k.agent.status(nur, 'ревью `df2caad`');
    await k.say(NUR_CHAT, '/sessions');
    expect(k.telegram.last(NUR_CHAT)?.html).toBe(
      [
        '<b>Сессии на связи:</b>',
        '',
        '🟢 <b>u7-school · dmg &lt;ui&gt;</b>',
        '<i>laptop · только что</i>',
        'ревью <code>df2caad</code>',
        '',
        '<i>Выбери адресата указания или команды (/clear, /compact, /exit).</i>',
      ].join('\n'),
    );
  });

  test('/status — статусы активных сессий без участия агента', async () => {
    const k = setup();
    await k.agent.status(nur, 'Фаза 2');
    k.clock.advance(30_000);
    await k.say(NUR_CHAT, '/status');
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('🟢 laptop · u7-school — Фаза 2 (только что)');
  });

  test('/status reply на сообщение сессии — только эта сессия', async () => {
    const k = setup();
    await k.agent.status(nur, 'Фаза 2');
    await k.agent.status(ops, 'бэкап');
    await k.agent.notify(ops, 'y');
    k.clock.advance(3 * 60_000);
    await k.say(NUR_CHAT, '/status', k.telegram.last(NUR_CHAT)!.messageId);
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('⚪ server · chronicle — бэкап (3 мин назад)');
  });

  test('нет сессий на связи', async () => {
    const k = setup();
    await k.agent.status(nur, 'Ф4');
    k.clock.advance(Session.ONLINE_MS + 1);
    await k.say(NUR_CHAT, '/sessions');
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('Сессий на связи нет.');
    await k.say(NUR_CHAT, '/status');
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('Сессий на связи нет.');
  });

  test('сессия без статуса в /status', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    await k.say(NUR_CHAT, '/status');
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('🟢 laptop · u7-school — статуса нет (только что)');
  });

  test('/status списком — только на связи; закрытая сессия не видна', async () => {
    const k = setup();
    await k.agent.status(nur, 'Ф4');
    await k.agent.status(ops, 'бэкап');
    await k.agent.bye(ops);
    await k.say(NUR_CHAT, '/status');
    expect(k.telegram.last(NUR_CHAT)?.text).toBe('🟢 laptop · u7-school — Ф4 (только что)');
  });
});

describe('Команды терминала', () => {
  test('/sessions → сессия → /clear: команда во входящих, реакция ✍, адресат сброшен', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    await k.say(NUR_CHAT, '/sessions');
    const menu = k.telegram.last(NUR_CHAT)!;
    await k.press(NUR_CHAT, menu.messageId, menu.buttons![0]![0]!.data);

    await k.say(NUR_CHAT, '/clear');
    expect((await k.agent.inbox(nur)).map((i) => [i.kind, i.text])).toEqual([['command', '/clear']]);
    expect(k.telegram.reaction(NUR_CHAT, 1003)).toBe('✍');

    await k.say(NUR_CHAT, 'ещё');
    expect(k.telegram.last(NUR_CHAT)?.text).toStartWith('Кому?');
  });

  test('reply на сообщение сессии (и на её вопрос) — команда этой сессии, не ответ', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    await k.say(NUR_CHAT, '/compact', k.telegram.last(NUR_CHAT)!.messageId);
    const q = await k.agent.ask(nur, db);
    await k.say(NUR_CHAT, '/clear@herald_bot', k.telegram.last(NUR_CHAT)!.messageId);

    expect((await k.agent.inbox(nur)).map((i) => [i.kind, i.text])).toEqual([
      ['command', '/compact'],
      ['command', '/clear'],
    ]);
    expect(k.store.question(q.id)?.status).toBe('open');
  });

  test('команда без адресата — «Кому?»', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    await k.say(NUR_CHAT, '/compact');
    expect(await k.agent.inbox(nur)).toEqual([]);
    expect(k.telegram.last(NUR_CHAT)?.text).toStartWith('Кому?');
  });

  test('неизвестная команда — список команд, выбранный адресат сохраняется', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    await k.say(NUR_CHAT, '/sessions');
    const menu = k.telegram.last(NUR_CHAT)!;
    await k.press(NUR_CHAT, menu.messageId, menu.buttons![0]![0]!.data);

    await k.say(NUR_CHAT, '/model opus');
    expect(k.telegram.last(NUR_CHAT)?.text).toBe(
      'Неизвестная команда. Есть: /new, /sessions, /status, /cancel, /clear, /compact, /exit.',
    );
    await k.say(NUR_CHAT, 'стоп');
    expect((await k.agent.inbox(nur)).map((i) => [i.kind, i.text])).toEqual([['directive', 'стоп']]);
  });
});

describe('Доступ (КП 7)', () => {
  test('чужой chat_id — ничего не принимается и не отправляется', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const qMsg = k.telegram.last(NUR_CHAT)!;
    const sent = k.telegram.sentTo(NUR_CHAT).length;

    await k.say(-555, 'стоп', qMsg.messageId);
    await k.say(-555, '/sessions');
    await k.press(-555, qMsg.messageId, `a:${q.id}:B`);

    expect(k.store.question(q.id)?.status).toBe('open');
    expect(await k.agent.inbox(nur)).toEqual([]);
    expect(k.telegram.sentTo(-555)).toEqual([]);
    expect(k.telegram.sentTo(NUR_CHAT)).toHaveLength(sent);
    expect(k.telegram.callbackAnswers.at(-1)).toEqual({ callbackId: 'cb3' });
  });

  test('кнопка вопроса чужого человека — отказ', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    await k.press(ANN_CHAT, 1, `a:${q.id}:B`);
    expect(k.store.question(q.id)?.status).toBe('open');
    expect(k.telegram.callbackAnswers.at(-1)?.text).toStartWith('⛔');
  });

  test('reply на сообщение чужой сессии — отказ', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    const nurMsg = k.telegram.last(NUR_CHAT)!;
    // Связь чужого сообщения подложена в чат Ann (тот же message_id в её чате).
    k.store.saveLink({ chatId: ANN_CHAT, messageId: nurMsg.messageId, sessionKey: nurKey });
    await k.say(ANN_CHAT, 'стоп', nurMsg.messageId);
    expect(await k.agent.inbox(nur)).toEqual([]);
    expect(k.telegram.last(ANN_CHAT)?.text).toStartWith('⛔');
  });

  test('/sessions показывает только свои сессии; кнопка чужой сессии — отказ', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    await k.agent.notify(ann, 'y');
    await k.say(NUR_CHAT, '/sessions');
    const nurMenu = k.telegram.last(NUR_CHAT)!;
    expect(nurMenu.text).not.toContain('site');

    await k.press(ANN_CHAT, 1, nurMenu.buttons![0]![0]!.data);
    expect(k.store.chatTarget(ANN_CHAT)).toBeUndefined();
    expect(k.telegram.callbackAnswers.at(-1)?.text).toStartWith('⛔');
  });

  test('неизвестная кнопка — подсказка', async () => {
    const k = setup();
    await k.press(NUR_CHAT, 1, 'zzz');
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('⚠️ кнопка устарела');
  });

  test('кнопка вопроса, удалённого очисткой, — «вопрос устарел и удалён»', async () => {
    const k = setup();
    const q = await k.agent.ask(nur, db);
    const qMsg = k.telegram.last(NUR_CHAT)!;
    k.store.purge(Number.MAX_SAFE_INTEGER);
    expect(k.store.question(q.id)).toBeUndefined();

    await k.press(NUR_CHAT, qMsg.messageId, `a:${q.id}:B`);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('⚠️ вопрос устарел и удалён');
    await k.press(NUR_CHAT, qMsg.messageId, `h:${q.id}`);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('⚠️ вопрос устарел и удалён');
  });
});
