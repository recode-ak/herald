import { describe, expect, test } from 'bun:test';
import { Question } from '../domain/question.ts';
import { Messages } from './messages.ts';

describe('Messages.ago', () => {
  const now = 10 * 86_400_000;
  test.each([
    [0, 'только что'],
    [59_999, 'только что'],
    [60_000, '1 мин назад'],
    [59 * 60_000, '59 мин назад'],
    [60 * 60_000, '1 ч назад'],
    [24 * 3_600_000 - 1, '23 ч назад'],
    [24 * 3_600_000, '1 дн назад'],
  ])('%d мс → %s', (elapsed, text) => {
    expect(Messages.ago(now - elapsed, now)).toBe(text);
  });
});

describe('Messages.answerText', () => {
  const q = Question.ask(
    { id: 'q1', sessionKey: 's', person: 'nur', text: 'x', options: [{ id: 'A', text: 'SQLite' }] },
    0,
  );
  test('вариант с подписью, свободный текст, неизвестный вариант — как есть', () => {
    expect(Messages.answerText(q, { by: 'human', option: 'A', at: 0 })).toBe('A: SQLite');
    expect(Messages.answerText(q, { by: 'human', text: 'потом', at: 0 })).toBe('потом');
    expect(Messages.answerText(q, { by: 'human', option: 'Z', at: 0 })).toBe('Z');
  });
});
