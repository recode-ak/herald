import { afterEach, describe, expect, test } from 'bun:test';
import { FakeBotApi } from './bot-api.fake.ts';

const fakes: FakeBotApi[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
});

function setup() {
  const fake = new FakeBotApi('tok');
  fakes.push(fake);
  const call = async (method: string, params: unknown = {}, token = 'tok') => {
    const res = await fetch(`${fake.baseUrl}/bot${token}/${method}`, { method: 'POST', body: JSON.stringify(params) });
    return { status: res.status, body: (await res.json()) as { ok: boolean; result?: unknown } };
  };
  return { fake, call };
}

describe('FakeBotApi', () => {
  test('чужой токен и неизвестный метод — отказ', async () => {
    const { call } = setup();
    expect((await call('sendMessage', {}, 'нет')).status).toBe(401);
    expect((await call('deleteMessage')).status).toBe(404);
  });

  test('sendMessage нумерует сообщения; вызовы записываются', async () => {
    const { fake, call } = setup();
    expect((await call('sendMessage', { chat_id: 1, text: 'a' })).body.result).toMatchObject({ message_id: 1 });
    expect((await call('sendMessage', { chat_id: 1, text: 'b' })).body.result).toMatchObject({ message_id: 2 });
    expect(fake.callsOf('sendMessage')).toEqual([
      { chat_id: 1, text: 'a' },
      { chat_id: 1, text: 'b' },
    ]);
  });

  test('getUpdates: по offset, подтверждённые удаляются', async () => {
    const { fake, call } = setup();
    fake.pushUpdate({ message: { text: 'a' } });
    fake.pushUpdate({ message: { text: 'b' } });
    expect((await call('getUpdates', { offset: 0 })).body.result).toHaveLength(2);
    expect((await call('getUpdates', { offset: 2 })).body.result).toEqual([{ message: { text: 'b' }, update_id: 2 }]);
    expect((await call('getUpdates', { offset: 0 })).body.result).toHaveLength(1);
  });

  test('сбои по сценарию — по одному на вызов', async () => {
    const { fake, call } = setup();
    fake.failNext('answerCallbackQuery', { status: 500, body: { ok: false } }, { status: 429, body: { ok: false } });
    expect((await call('answerCallbackQuery')).status).toBe(500);
    expect((await call('answerCallbackQuery')).status).toBe(429);
    expect((await call('answerCallbackQuery')).body).toEqual({ ok: true, result: true });
  });
});
