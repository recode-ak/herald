import { describe, expect, test } from 'bun:test';
import { DomainError } from '../domain/errors.ts';
import { InboxItem } from '../domain/inbox.ts';
import { Session } from '../domain/session.ts';
import { AgentService } from './agent.ts';
import { Messages } from './messages.ts';
import { ForbiddenError, NotFoundError } from './ports.ts';
import { TelegramError } from './telegram.ts';
import { ann, NUR_CHAT, nur, testkit } from './testkit.fake.ts';

function setup() {
  const kit = testkit();
  return { ...kit, agent: new AgentService(kit) };
}

const nurKey = Session.keyOf(nur.session);
const db = {
  text: 'Какую БД?',
  options: [
    { id: 'A', text: 'SQLite' },
    { id: 'B', text: 'Postgres' },
  ],
  recommended: 'A',
  timeoutMs: 180_000,
};

describe('AgentService.notify', () => {
  test('сообщение получателю токена с шапкой [host · проект]; сессия регистрируется', async () => {
    const { agent, telegram, store, clock } = setup();
    await agent.notify(nur, 'Фаза 2 готова');

    const msg = telegram.last(NUR_CHAT);
    expect(msg?.text).toBe('[laptop · u7-school]\nФаза 2 готова');
    expect(store.session(nurKey)?.lastSeenAt).toBe(clock.now());
    expect(store.link(NUR_CHAT, msg!.messageId)).toEqual({
      chatId: NUR_CHAT,
      messageId: msg!.messageId,
      sessionKey: nurKey,
    });
  });

  test('ошибка доставки — ошибка; связь не сохраняется', async () => {
    const { agent, telegram, store } = setup();
    telegram.failNext('бот заблокирован');
    await expect(agent.notify(nur, 'x')).rejects.toBeInstanceOf(TelegramError);
    expect(store.linksOfQuestion('нет')).toEqual([]);
    expect(telegram.sentTo(NUR_CHAT)).toEqual([]);
  });

  test('пустой текст — DomainError', async () => {
    const { agent } = setup();
    await expect(agent.notify(nur, '  ')).rejects.toBeInstanceOf(DomainError);
  });

  test('явное имя сессии — проект в шапке', async () => {
    const { agent, telegram } = setup();
    await agent.notify({ ...nur, session: { ...nur.session, name: 'ops' } }, 'x');
    expect(telegram.last(NUR_CHAT)?.text).toBe('[laptop · ops]\nx');
  });

  test('сессия чужого человека с тем же ключом — отказ', async () => {
    const { agent } = setup();
    await agent.notify(nur, 'x');
    await expect(agent.notify({ ...ann, session: nur.session }, 'y')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('AgentService.ask', () => {
  test('кнопки вариантов с пометкой рекомендованного и «Жди меня»; вопрос сохранён', async () => {
    const { agent, telegram, store } = setup();
    const q = await agent.ask(nur, db);

    expect(q.id).toBe('q_1');
    expect(q.status).toBe('open');
    expect(store.question('q_1')?.sessionKey).toBe(nurKey);

    const msg = telegram.last(NUR_CHAT)!;
    expect(msg.text).toBe(
      '[laptop · u7-school]\n❓ Какую БД?\n\nA: SQLite ⭐\nB: Postgres\n\nОтветь кнопкой или reply на это сообщение.' +
        '\n\n⏳ На раздумье 3 мин — до 05:19, потом агент решит сам.',
    );
    expect(msg.buttons).toEqual([
      [{ text: 'A ⭐', data: 'a:q_1:A' }],
      [{ text: 'B', data: 'a:q_1:B' }],
      [{ text: 'Жди меня', data: 'h:q_1' }],
    ]);
    expect(store.link(NUR_CHAT, msg.messageId)?.questionId).toBe('q_1');
  });

  test('без вариантов — только «Жди меня» и свободный ответ', async () => {
    const { agent, telegram } = setup();
    await agent.ask(nur, { text: 'Как назвать?', options: [], timeoutMs: 60_000 });
    const msg = telegram.last(NUR_CHAT)!;
    expect(msg.text).toBe(
      '[laptop · u7-school]\n❓ Как назвать?\n\nОтветь reply на это сообщение.\n\n⏳ На раздумье 1 мин — до 05:17, потом агент решит сам.',
    );
    expect(msg.buttons).toEqual([[{ text: 'Жди меня', data: 'h:q_1' }]]);
  });

  test('без таймаута — время не ограничено, «Жди меня» нет; решать агенту нельзя', async () => {
    const { agent, telegram, store } = setup();
    const { timeoutMs: _, ...untimed } = db;
    const q = await agent.ask(nur, untimed);
    const msg = telegram.last(NUR_CHAT)!;
    expect(msg.text).toEndWith('\n\n⏳ Время не ограничено: агент ждёт твоего ответа.');
    expect(msg.buttons).toEqual([[{ text: 'A ⭐', data: 'a:q_1:A' }], [{ text: 'B', data: 'a:q_1:B' }]]);
    await expect(agent.decide(nur, q.id, { option: 'A' }, 'по таймауту')).rejects.toThrow('без таймаута');
    expect(store.question(q.id)?.status).toBe('open');
  });

  test('ошибка доставки — вопрос не сохраняется', async () => {
    const { agent, telegram, store } = setup();
    telegram.failNext();
    await expect(agent.ask(nur, db)).rejects.toBeInstanceOf(TelegramError);
    expect(store.question('q_1')).toBeUndefined();
  });

  test('длинный id варианта (callback_data > 64 байт) — DomainError', async () => {
    const { agent } = setup();
    await expect(agent.ask(nur, { text: 'x', options: [{ id: 'Я'.repeat(40), text: 'y' }] })).rejects.toBeInstanceOf(
      DomainError,
    );
  });
});

describe('AgentService.answered', () => {
  test('ответ человека в терминале: вопрос закрыт, сообщение обновлено без кнопок, во входящих ничего', async () => {
    const { agent, telegram, store } = setup();
    const { timeoutMs: _, ...untimed } = db;
    const q = await agent.ask(nur, untimed);
    const before = telegram.last(NUR_CHAT)!;

    const answered = await agent.answered(nur, q.id, { option: 'B' });
    expect(answered.resolution).toMatchObject({ by: 'human', option: 'B', via: 'terminal' });
    expect(store.question(q.id)?.status).toBe('answered');
    const after = telegram.message(NUR_CHAT, before.messageId)!;
    expect(after.text).toEndWith('\n\n👤 Принят B (в терминале).');
    expect(after.buttons).toEqual([]);
    expect(await agent.inbox(nur)).toEqual([]);
  });

  test('чужой вопрос — ForbiddenError; уже решённый — DomainError', async () => {
    const { agent } = setup();
    const q = await agent.ask(nur, db);
    await expect(agent.answered(ann, q.id, { option: 'A' })).rejects.toBeInstanceOf(ForbiddenError);
    await agent.decide(nur, q.id, { option: 'A' }, 'по таймауту');
    await expect(agent.answered(nur, q.id, { option: 'B' })).rejects.toBeInstanceOf(DomainError);
  });
});

describe('AgentService.decide', () => {
  test('решение по таймауту: сообщение обновляется, кнопки вариантов остаются, «Жди меня» — нет', async () => {
    const { agent, telegram, store } = setup();
    const q = await agent.ask(nur, db);
    const before = telegram.last(NUR_CHAT)!;

    const decided = agent.decide(nur, q.id, { option: 'A' }, 'по таймауту');
    await decided;
    expect(store.question(q.id)?.status).toBe('decided');

    const after = telegram.message(NUR_CHAT, before.messageId)!;
    expect(after.text).toBe(before.text.replace(/⏳ .*$/, '🤖 Принят A по таймауту. Кнопки — чтобы переиграть.'));
    expect(after.buttons).toEqual(before.buttons?.slice(0, -1));
  });

  test('свободный текст решения', async () => {
    const { agent, telegram } = setup();
    const q = await agent.ask(nur, { text: 'Как назвать?', options: [], timeoutMs: 0 });
    await agent.decide(nur, q.id, { text: 'herald' }, 'по таймауту');
    expect(telegram.last(NUR_CHAT)?.text).toEndWith('🤖 Принято «herald» по таймауту. Кнопки — чтобы переиграть.');
  });

  test('чужой вопрос — ForbiddenError, неизвестный — NotFoundError', async () => {
    const { agent } = setup();
    const q = await agent.ask(nur, db);
    await expect(agent.decide(ann, q.id, { option: 'A' }, 'x')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(agent.decide(nur, 'q_9', { option: 'A' }, 'x')).rejects.toBeInstanceOf(NotFoundError);
  });

  test('ошибка правки сообщения не отменяет решение', async () => {
    const { agent, telegram, store } = setup();
    const q = await agent.ask(nur, db);
    telegram.failNext();
    await agent.decide(nur, q.id, { option: 'B' }, 'по таймауту');
    expect(store.question(q.id)?.status).toBe('decided');
  });
});

describe('AgentService.status', () => {
  test('статус сохраняется, в Telegram ничего не уходит', async () => {
    const { agent, telegram, store, clock } = setup();
    await agent.status(nur, 'Фаза 2: сценарии');
    expect(store.session(nurKey)?.status).toEqual({ text: 'Фаза 2: сценарии', at: clock.now() });
    expect(telegram.sentTo(NUR_CHAT)).toEqual([]);
  });
});

describe('AgentService — разметка', () => {
  test('notify и ask уходят с HTML; при правке вопроса HTML тоже обновляется', async () => {
    const { agent, telegram } = setup();
    await agent.notify(nur, '**Фаза 4** готова');
    expect(telegram.last(NUR_CHAT)?.html).toBe('<b>[laptop · u7-school]</b>\n<b>Фаза 4</b> готова');

    const q = await agent.ask(nur, db);
    const msg = telegram.last(NUR_CHAT)!;
    expect(msg.html).toStartWith('<b>[laptop · u7-school]</b>\n❓ <b>Какую БД?</b>');
    await agent.decide(nur, q.id, { option: 'A' }, 'по таймауту');
    expect(telegram.message(NUR_CHAT, msg.messageId)?.html).toEndWith(
      '🤖 Принят A по таймауту. Кнопки — чтобы переиграть.',
    );
  });
});

describe('AgentService.bye', () => {
  test('окно закрыто — сессия не на связи', async () => {
    const { agent, store, clock, telegram } = setup();
    await agent.bye(nur);
    expect(store.session(nurKey)?.closedAt).toBe(clock.now());
    expect(store.session(nurKey)?.isOnline(clock.now())).toBe(false);
    expect(telegram.sentTo(NUR_CHAT)).toEqual([]);
  });

  test('непрочитанные указания — человеку сообщение со списком; ответы и команды не в счёт', async () => {
    const { agent, store, clock, telegram } = setup();
    await agent.notify(nur, 'x');
    const post = (id: string, kind: 'directive' | 'command', text: string) =>
      store.saveInboxItem(InboxItem.create({ id, sessionKey: nurKey, person: 'nur', kind, text }, clock.now()));
    post('i1', 'directive', 'не трогай миграции');
    post('i2', 'command', '/compact');
    post('i3', 'directive', 'y'.repeat(300));
    await agent.ack(nur, ['i1']);
    post('i4', 'directive', 'и обнови доки');

    await agent.bye(nur);

    expect(telegram.last(NUR_CHAT)?.text).toBe(
      [
        '⚠️ u7-school закрыта, указания не прочитаны:',
        `• ${'y'.repeat(Messages.UNREAD_PREVIEW - 1)}…`,
        '• и обнови доки',
      ].join('\n'),
    );
  });
});

describe('AgentService.title', () => {
  test('название сессии — в шапке следующих сообщений', async () => {
    const { agent, telegram, store } = setup();
    await agent.title(nur, 'dmg-ui · Ф4');
    expect(store.session(nurKey)?.title).toBe('dmg-ui · Ф4');
    expect(telegram.sentTo(NUR_CHAT)).toEqual([]);
    await agent.notify(nur, 'Готово');
    expect(telegram.last(NUR_CHAT)?.text).toBe('[laptop · u7-school · dmg-ui · Ф4]\nГотово');
  });
});

describe('AgentService.inbox и ack', () => {
  function directive(kit: ReturnType<typeof setup>, id: string, text: string) {
    kit.store.saveInboxItem(
      InboxItem.create({ id, sessionKey: nurKey, person: 'nur', kind: 'directive', text }, kit.clock.now()),
    );
  }

  test('выдача непрочитанных; сессия отмечается активной', async () => {
    const kit = setup();
    await kit.agent.status(nur, 'старт');
    directive(kit, 'i_1', 'стоп');
    kit.clock.advance(1000);
    expect((await kit.agent.inbox(nur)).map((i) => i.text)).toEqual(['стоп']);
    expect(kit.store.session(nurKey)?.lastSeenAt).toBe(kit.clock.now());
  });

  test('ack: реакция на сообщении человека ✍ → 👀, повторный ack — без правок', async () => {
    const kit = setup();
    directive(kit, 'i_1', 'стоп');
    kit.store.saveLink({ chatId: NUR_CHAT, messageId: 500, sessionKey: nurKey, inboxId: 'i_1' });

    expect(await kit.agent.ack(nur, ['i_1'])).toEqual(['i_1']);
    expect(kit.telegram.reaction(NUR_CHAT, 500)).toBe('👀');
    expect(await kit.agent.inbox(nur)).toEqual([]);

    expect(await kit.agent.ack(nur, ['i_1'])).toEqual([]);
    expect(kit.telegram.reactions).toHaveLength(1);
  });

  test('ack неизвестного id — DomainError; ничего не отмечено', async () => {
    const kit = setup();
    directive(kit, 'i_1', 'стоп');
    await expect(kit.agent.ack(nur, ['i_1', 'i_9'])).rejects.toBeInstanceOf(DomainError);
    expect((await kit.agent.inbox(nur)).map((i) => i.id)).toEqual(['i_1']);
  });

  test('ошибка правки отметки не мешает подтверждению', async () => {
    const kit = setup();
    directive(kit, 'i_1', 'стоп');
    const mark = await kit.telegram.send({ chatId: NUR_CHAT, text: '📥' });
    kit.store.saveLink({ chatId: NUR_CHAT, messageId: mark, sessionKey: nurKey, inboxId: 'i_1' });
    kit.telegram.failNext();
    expect(await kit.agent.ack(nur, ['i_1'])).toEqual(['i_1']);
  });
});
