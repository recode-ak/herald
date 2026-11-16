import { describe, expect, test } from 'bun:test';
import { InboxItem } from '../domain/inbox.ts';
import { Question } from '../domain/question.ts';
import { Wire } from './wire.ts';

describe('Wire', () => {
  test('вопрос — без человека и ключа сессии; необязательные поля только при наличии', () => {
    const draft = { id: 'q_1', sessionKey: 'h:/r', person: 'nur', text: 'БД?', options: [{ id: 'A', text: 'SQLite' }] };
    expect(Wire.question(Question.ask(draft, 5))).toEqual({
      id: 'q_1',
      text: 'БД?',
      options: [{ id: 'A', text: 'SQLite' }],
      status: 'open',
      askedAt: 5,
      lateAnswers: [],
    });

    const q = Question.ask({ ...draft, recommended: 'A' }, 5);
    q.hold(6);
    q.answer({ option: 'A' }, 7);
    expect(Wire.question(q)).toEqual({
      id: 'q_1',
      text: 'БД?',
      options: [{ id: 'A', text: 'SQLite' }],
      recommended: 'A',
      status: 'answered',
      askedAt: 5,
      heldAt: 6,
      resolution: { by: 'human', option: 'A', at: 7 },
      lateAnswers: [],
    });
  });

  test('входящее — без человека, сессии и времени прочтения', () => {
    const base = { sessionKey: 'h:/r', person: 'nur' };
    const directive = InboxItem.create({ ...base, id: 'i_1', kind: 'directive', text: 'тесты' }, 9);
    directive.markRead(10);
    expect(Wire.inboxItem(directive)).toEqual({ id: 'i_1', kind: 'directive', text: 'тесты', createdAt: 9 });
    const answer = InboxItem.create(
      { ...base, id: 'i_2', kind: 'answer', text: 'A', questionId: 'q_1', option: 'A' },
      9,
    );
    expect(Wire.inboxItem(answer)).toEqual({
      id: 'i_2',
      kind: 'answer',
      text: 'A',
      questionId: 'q_1',
      option: 'A',
      createdAt: 9,
    });
  });
});
