import { afterEach, describe, expect, test } from 'bun:test';
import { TelegramError } from '../app/telegram.ts';
import { FakeBotApi } from './bot-api.fake.ts';
import { SystemClock } from './system.ts';
import { TelegramBotApi } from './telegram.ts';

const fakes: FakeBotApi[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

function setup(token = 'bot-token') {
  const fake = new FakeBotApi('bot-token');
  fakes.push(fake);
  const api = new TelegramBotApi({ token, baseUrl: fake.baseUrl, clock: new SystemClock(), retryDelayMs: 1 });
  return { fake, api };
}

const buttons = [[{ text: 'A ⭐', data: 'a:q_1:A' }], [{ text: '⏸ Жди меня', data: 'h:q_1' }]];

describe('TelegramBotApi — исходящие', () => {
  test('sendMessage с inline-кнопками и reply; возвращает message_id', async () => {
    const { fake, api } = setup();
    expect(await api.send({ chatId: 111, text: 'Вопрос', buttons, replyTo: 7 })).toBe(1);
    expect(await api.send({ chatId: 111, text: 'Ещё' })).toBe(2);
    expect(fake.callsOf('sendMessage')).toEqual([
      {
        chat_id: 111,
        text: 'Вопрос',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'A ⭐', callback_data: 'a:q_1:A' }],
            [{ text: '⏸ Жди меня', callback_data: 'h:q_1' }],
          ],
        },
        reply_parameters: { message_id: 7, allow_sending_without_reply: true },
      },
      { chat_id: 111, text: 'Ещё' },
    ]);
  });

  test('editMessageText: с кнопками и без (кнопки убираются)', async () => {
    const { fake, api } = setup();
    await api.edit(111, 5, 'Новый', buttons);
    await api.edit(111, 5, 'Без кнопок');
    const [withButtons, without] = fake.callsOf('editMessageText');
    expect(withButtons).toMatchObject({ chat_id: 111, message_id: 5, text: 'Новый' });
    expect(without).toEqual({ chat_id: 111, message_id: 5, text: 'Без кнопок', reply_markup: { inline_keyboard: [] } });
  });

  test('edit без изменений («message is not modified») — не ошибка', async () => {
    const { fake, api } = setup();
    fake.failNext('editMessageText', {
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: message is not modified' },
    });
    await api.edit(111, 5, 'Тот же');
  });

  test('answerCallbackQuery с текстом и без', async () => {
    const { fake, api } = setup();
    await api.answerCallback('cb1', 'Принято');
    await api.answerCallback('cb2');
    expect(fake.callsOf('answerCallbackQuery')).toEqual([
      { callback_query_id: 'cb1', text: 'Принято' },
      { callback_query_id: 'cb2' },
    ]);
  });

  test('html — parse_mode HTML; Telegram не разобрал разметку — повтор обычным текстом', async () => {
    const { fake, api } = setup();
    await api.send({ chatId: 111, text: '**x**', html: '<b>x</b>' });
    expect(fake.callsOf('sendMessage').at(-1)).toEqual({ chat_id: 111, text: '<b>x</b>', parse_mode: 'HTML' });

    const parseError = {
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unclosed tag" },
    };
    fake.failNext('sendMessage', parseError);
    expect(await api.send({ chatId: 111, text: '**y**', html: '<b>y' })).toBeNumber();
    expect(fake.callsOf('sendMessage').at(-1)).toEqual({ chat_id: 111, text: '**y**' });

    await api.edit(111, 5, '**z**', undefined, '<b>z</b>');
    expect(fake.callsOf('editMessageText').at(-1)).toMatchObject({ text: '<b>z</b>', parse_mode: 'HTML' });
    fake.failNext('editMessageText', parseError);
    await api.edit(111, 5, '**w**', undefined, '<b>w');
    expect(fake.callsOf('editMessageText').at(-1)).toEqual({
      chat_id: 111,
      message_id: 5,
      text: '**w**',
      reply_markup: { inline_keyboard: [] },
    });
  });

  test('setMessageReaction: одна эмодзи-реакция заменяет прежнюю', async () => {
    const { fake, api } = setup();
    await api.react(111, 42, '👀');
    expect(fake.callsOf('setMessageReaction')).toEqual([
      { chat_id: 111, message_id: 42, reaction: [{ type: 'emoji', emoji: '👀' }] },
    ]);
  });
});

describe('TelegramBotApi — ошибки и повторы', () => {
  test('4xx — TelegramError сразу, без повтора; описание Bot API в тексте', async () => {
    const { fake, api } = setup();
    fake.failNext('sendMessage', {
      status: 403,
      body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    });
    const error = await api.send({ chatId: 111, text: 'x' }).catch((e) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect(error.message).toContain('bot was blocked by the user');
    expect(fake.callsOf('sendMessage')).toHaveLength(1);
  });

  test('5xx и 429 — повтор; 429 ждёт retry_after', async () => {
    const { fake, api } = setup();
    fake.failNext(
      'sendMessage',
      { status: 502, body: 'Bad Gateway' },
      {
        status: 429,
        body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } },
      },
    );
    expect(await api.send({ chatId: 111, text: 'x' })).toBe(1);
    expect(fake.callsOf('sendMessage')).toHaveLength(3);
  });

  test('повторы исчерпаны — TelegramError', async () => {
    const { fake, api } = setup();
    const down = { status: 500, body: { ok: false, error_code: 500, description: 'Internal Server Error' } };
    fake.failNext('sendMessage', down, down, down, down);
    await expect(api.send({ chatId: 111, text: 'x' })).rejects.toBeInstanceOf(TelegramError);
    expect(fake.callsOf('sendMessage')).toHaveLength(3);
  });

  test('сеть недоступна — TelegramError; токен не попадает в текст ошибки', async () => {
    const api = new TelegramBotApi({
      token: 'secret-123',
      baseUrl: 'http://127.0.0.1:1',
      clock: new SystemClock(),
      retryDelayMs: 1,
    });
    const error = await api.send({ chatId: 111, text: 'x' }).catch((e) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect(error.message).not.toContain('secret-123');
  });

  test('неверный токен — TelegramError', async () => {
    const { api } = setup('wrong');
    await expect(api.send({ chatId: 111, text: 'x' })).rejects.toThrow('Unauthorized');
  });
});

describe('TelegramBotApi.getUpdates', () => {
  test('текст, reply и нажатие кнопки → TelegramUpdate; прочее пропускается, но двигает offset', async () => {
    const { fake, api } = setup();
    fake.pushUpdate({ message: { message_id: 10, chat: { id: 111 }, text: '/sessions' } });
    fake.pushUpdate({
      message: { message_id: 11, chat: { id: 111 }, text: 'Займись тестами', reply_to_message: { message_id: 3 } },
    });
    fake.pushUpdate({ callback_query: { id: 'cb1', data: 'a:q_1:B', message: { message_id: 4, chat: { id: 111 } } } });
    fake.pushUpdate({ message: { message_id: 12, chat: { id: 111 }, sticker: {} } });

    const batch = await api.getUpdates(0, 0);
    expect(batch.updates).toEqual([
      { kind: 'message', updateId: 1, chatId: 111, messageId: 10, text: '/sessions' },
      { kind: 'message', updateId: 2, chatId: 111, messageId: 11, text: 'Займись тестами', replyTo: 3 },
      { kind: 'callback', updateId: 3, callbackId: 'cb1', chatId: 111, messageId: 4, data: 'a:q_1:B' },
    ]);
    expect(batch.nextOffset).toBe(5);
    expect(fake.callsOf('getUpdates')[0]).toEqual({
      offset: 0,
      timeout: 0,
      allowed_updates: ['message', 'callback_query'],
    });
  });

  test('offset подтверждает прочитанные; пусто — nextOffset прежний', async () => {
    const { fake, api } = setup();
    fake.pushUpdate({ message: { message_id: 1, chat: { id: 111 }, text: 'a' } });
    const first = await api.getUpdates(0, 0);
    expect(await api.getUpdates(first.nextOffset, 0)).toEqual({ updates: [], nextOffset: first.nextOffset });
  });

  test('long poll: ждёт апдейта до timeout', async () => {
    const { fake, api } = setup();
    const polling = api.getUpdates(0, 5);
    await Bun.sleep(20);
    fake.pushUpdate({ message: { message_id: 1, chat: { id: 111 }, text: 'проснись' } });
    expect((await polling).updates).toHaveLength(1);
  });

  test('отмена через signal — обрыв без повторов', async () => {
    const { fake, api } = setup();
    const stop = new AbortController();
    const polling = api.getUpdates(0, 5, stop.signal);
    await Bun.sleep(20);
    stop.abort();
    await expect(polling).rejects.toThrow();
    expect(fake.callsOf('getUpdates')).toHaveLength(1);
  });
});
