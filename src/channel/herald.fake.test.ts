import { describe, expect, test } from 'bun:test';
import { FakeHerald } from './herald.fake.ts';

const item = { id: 'i_1', kind: 'directive' as const, text: 'x', createdAt: 1 };

describe('FakeHerald', () => {
  test('запоминает вызовы; ask нумерует вопросы', async () => {
    const h = new FakeHerald();
    await h.notify('a');
    await h.status('s');
    expect((await h.ask({ text: 'q', options: [] })).id).toBe('q_1');
    expect((await h.decide('q_1', { option: 'A' }, 'r')).status).toBe('decided');
    expect([h.notified, h.statuses, h.decided]).toEqual([
      ['a'],
      ['s'],
      [{ id: 'q_1', choice: { option: 'A' }, reason: 'r' }],
    ]);
  });

  test('inbox: без входящих — короткое ожидание и пусто; push будит; ack убирает', async () => {
    const h = new FakeHerald();
    expect(await h.inbox()).toEqual([]);
    const waiting = h.inbox();
    h.push(item);
    expect(await waiting).toEqual([item]);
    expect(await h.ack(['i_1'])).toEqual(['i_1']);
    expect(await h.inbox()).toEqual([]);
    expect(h.polls).toBe(3);
  });

  test('failNext — одна ошибка', async () => {
    const h = new FakeHerald();
    h.failNext('нет');
    await expect(h.notify('a')).rejects.toThrow('нет');
    await h.notify('b');
    expect(h.notified).toEqual(['b']);
  });
});
