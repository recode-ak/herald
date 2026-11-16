import { describe, expect, test } from 'bun:test';
import { FakeTelegram } from './telegram.fake.ts';
import { TelegramError } from './telegram.ts';

describe('FakeTelegram', () => {
  test('send выдаёт возрастающие message_id и хранит сообщения', async () => {
    const tg = new FakeTelegram();
    const a = await tg.send({ chatId: 111, text: 'один' });
    const b = await tg.send({ chatId: 111, text: 'два', buttons: [[{ text: 'A', data: 'q:1:A' }]], replyTo: a });
    expect(b).toBeGreaterThan(a);
    expect(tg.message(111, b)).toEqual({
      chatId: 111,
      messageId: b,
      text: 'два',
      buttons: [[{ text: 'A', data: 'q:1:A' }]],
      replyTo: a,
    });
    expect(tg.sentTo(111).map((m) => m.text)).toEqual(['один', 'два']);
    expect(tg.last(111)?.text).toBe('два');
  });

  test('edit меняет текст и кнопки, история правок сохраняется', async () => {
    const tg = new FakeTelegram();
    const id = await tg.send({ chatId: 111, text: 'вопрос', buttons: [[{ text: 'A', data: 'x' }]] });
    await tg.edit(111, id, 'принят A');
    expect(tg.message(111, id)?.text).toBe('принят A');
    expect(tg.message(111, id)?.buttons).toBeUndefined();
    expect(tg.edits).toEqual([{ chatId: 111, messageId: id, text: 'принят A' }]);
  });

  test('edit несуществующего сообщения — ошибка', async () => {
    const tg = new FakeTelegram();
    await expect(tg.edit(111, 5, 'x')).rejects.toBeInstanceOf(TelegramError);
  });

  test('answerCallback записывается', async () => {
    const tg = new FakeTelegram();
    await tg.answerCallback('cb1', 'принято');
    await tg.answerCallback('cb2');
    expect(tg.callbackAnswers).toEqual([{ callbackId: 'cb1', text: 'принято' }, { callbackId: 'cb2' }]);
  });

  test('failNext — следующая операция падает TelegramError, затем работает', async () => {
    const tg = new FakeTelegram();
    tg.failNext('бот заблокирован');
    await expect(tg.send({ chatId: 111, text: 'x' })).rejects.toThrow('бот заблокирован');
    expect(tg.sentTo(111)).toEqual([]);
    await tg.send({ chatId: 111, text: 'y' });
    expect(tg.sentTo(111)).toHaveLength(1);
  });
});
