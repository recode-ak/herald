import { describe, expect, test } from 'bun:test';
import { DomainError } from './errors.ts';
import { Inbox, InboxItem } from './inbox.ts';

const t0 = 5_000;
const base = { sessionKey: 'h:/x', person: 'nur' };

describe('InboxItem', () => {
  test('указание человека', () => {
    const item = InboxItem.create({ ...base, id: 'i1', kind: 'directive', text: '  стоп  ' }, t0);
    expect(item.kind).toBe('directive');
    expect(item.text).toBe('стоп');
    expect(item.isRead).toBe(false);
  });

  test('ответ и поздний ответ — с id вопроса', () => {
    const a = InboxItem.create({ ...base, id: 'i1', kind: 'answer', text: 'B', questionId: 'q1', option: 'B' }, t0);
    expect(a.questionId).toBe('q1');
    expect(a.option).toBe('B');
    expect(() => InboxItem.create({ ...base, id: 'i2', kind: 'late-answer', text: 'B' }, t0)).toThrow(DomainError);
  });

  test('пустой текст — ошибка', () => {
    expect(() => InboxItem.create({ ...base, id: 'i1', kind: 'directive', text: ' ' }, t0)).toThrow(DomainError);
  });

  test('прочтение — один раз, время первого', () => {
    const item = InboxItem.create({ ...base, id: 'i1', kind: 'directive', text: 'стоп' }, t0);
    expect(item.markRead(t0 + 1)).toBe(true);
    expect(item.markRead(t0 + 2)).toBe(false);
    expect(item.readAt).toBe(t0 + 1);
  });

  test('состояние сохраняется и восстанавливается', () => {
    const item = InboxItem.create({ ...base, id: 'i1', kind: 'answer', text: 'A', questionId: 'q', option: 'A' }, t0);
    item.markRead(t0 + 1);
    expect(InboxItem.restore(item.toState()).toState()).toEqual(item.toState());
  });
});

describe('Inbox — входящие одной сессии', () => {
  const make = (id: string, at: number, sessionKey = base.sessionKey) =>
    InboxItem.create({ ...base, sessionKey, id, kind: 'directive', text: id }, at);

  test('непрочитанные — по времени, затем по id', () => {
    const inbox = new Inbox(base.sessionKey, [make('b', t0 + 2), make('c', t0 + 1), make('a', t0 + 2)]);
    expect(inbox.pending().map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  test('подтверждение прочтения возвращает только впервые прочитанные', () => {
    const items = [make('a', t0), make('b', t0 + 1)];
    const inbox = new Inbox(base.sessionKey, items);
    expect(inbox.ack(['a'], t0 + 10).map((i) => i.id)).toEqual(['a']);
    expect(inbox.ack(['a', 'b'], t0 + 11).map((i) => i.id)).toEqual(['b']);
    expect(inbox.pending()).toEqual([]);
  });

  test('неизвестный id при подтверждении — ошибка, ничего не прочитано', () => {
    const inbox = new Inbox(base.sessionKey, [make('a', t0)]);
    expect(() => inbox.ack(['a', 'zz'], t0 + 1)).toThrow(DomainError);
    expect(inbox.pending().map((i) => i.id)).toEqual(['a']);
  });

  test('элемент чужой сессии в ящик не принимается', () => {
    expect(() => new Inbox(base.sessionKey, [make('a', t0, 'other:/y')])).toThrow(DomainError);
  });
});
