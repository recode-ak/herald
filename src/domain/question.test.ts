import { describe, expect, test } from 'bun:test';
import { DomainError } from './errors.ts';
import { Question, type QuestionDraft } from './question.ts';

const t0 = 1_000_000;
const draft: QuestionDraft = {
  id: 'q1',
  sessionKey: 'h:/x',
  person: 'nur',
  text: 'Хранить в SQLite?',
  options: [
    { id: 'A', text: 'SQLite' },
    { id: 'B', text: 'JSON' },
  ],
  recommended: 'A',
};

describe('Question — создание', () => {
  test('открытый вопрос с вариантами и рекомендованным', () => {
    const q = Question.ask(draft, t0);
    expect(q.status).toBe('open');
    expect(q.recommended).toBe('A');
    expect(q.options.map((o) => o.id)).toEqual(['A', 'B']);
    expect(q.askedAt).toBe(t0);
  });

  test('вопрос без вариантов — только свободный ответ', () => {
    const q = Question.ask({ ...draft, options: [], recommended: undefined }, t0);
    expect(q.options).toEqual([]);
  });

  test('пустой текст, пустой или повторный id варианта — ошибка', () => {
    expect(() => Question.ask({ ...draft, text: ' ' }, t0)).toThrow(DomainError);
    expect(() => Question.ask({ ...draft, options: [{ id: ' ', text: 'x' }] }, t0)).toThrow(DomainError);
    expect(() =>
      Question.ask(
        {
          ...draft,
          options: [
            { id: 'A', text: 'x' },
            { id: 'A', text: 'y' },
          ],
        },
        t0,
      ),
    ).toThrow(DomainError);
  });

  test('рекомендованный — только из вариантов', () => {
    expect(() => Question.ask({ ...draft, recommended: 'C' }, t0)).toThrow(DomainError);
  });
});

describe('Question — ответ человека', () => {
  test('выбор варианта: open → answered', () => {
    const q = Question.ask(draft, t0);
    expect(q.answer({ option: 'B' }, t0 + 1)).toBe('answer');
    expect(q.status).toBe('answered');
    expect(q.resolution).toEqual({ by: 'human', option: 'B', at: t0 + 1 });
  });

  test('свободный текст: open → answered', () => {
    const q = Question.ask(draft, t0);
    q.answer({ text: '  оба, но позже  ' }, t0 + 1);
    expect(q.resolution).toEqual({ by: 'human', text: 'оба, но позже', at: t0 + 1 });
  });

  test('неизвестный вариант или пустой ответ — ошибка', () => {
    const q = Question.ask(draft, t0);
    expect(() => q.answer({ option: 'C' }, t0)).toThrow(DomainError);
    expect(() => q.answer({ text: ' ' }, t0)).toThrow(DomainError);
    expect(q.status).toBe('open');
  });

  test('повторный ответ — поздний, первое решение не меняется', () => {
    const q = Question.ask(draft, t0);
    q.answer({ option: 'A' }, t0 + 1);
    expect(q.answer({ option: 'B' }, t0 + 2)).toBe('late');
    expect(q.resolution?.option).toBe('A');
    expect(q.lateAnswers).toEqual([{ by: 'human', option: 'B', at: t0 + 2 }]);
  });
});

describe('Question — решение агента', () => {
  test('decide: open → decided с причиной', () => {
    const q = Question.ask(draft, t0);
    q.decide({ option: 'A' }, 'по таймауту', t0 + 180_000);
    expect(q.status).toBe('decided');
    expect(q.resolution).toEqual({ by: 'agent', option: 'A', reason: 'по таймауту', at: t0 + 180_000 });
  });

  test('ответ человека после decide — поздний', () => {
    const q = Question.ask(draft, t0);
    q.decide({ option: 'A' }, 'по таймауту', t0 + 1);
    expect(q.answer({ option: 'B' }, t0 + 2)).toBe('late');
    expect(q.status).toBe('decided');
    expect(q.lateAnswers.at(-1)?.option).toBe('B');
  });

  test('decide только из open', () => {
    const q = Question.ask(draft, t0);
    q.answer({ option: 'B' }, t0 + 1);
    expect(() => q.decide({ option: 'A' }, 'по таймауту', t0 + 2)).toThrow(DomainError);
  });

  test('decide с неизвестным вариантом или без причины — ошибка', () => {
    const q = Question.ask(draft, t0);
    expect(() => q.decide({ option: 'C' }, 'по таймауту', t0)).toThrow(DomainError);
    expect(() => q.decide({ option: 'A' }, ' ', t0)).toThrow(DomainError);
  });
});

describe('Question — «Жди меня»', () => {
  test('удержание: вопрос открыт, решать агенту нельзя', () => {
    const q = Question.ask(draft, t0);
    q.hold(t0 + 1);
    expect(q.status).toBe('open');
    expect(q.heldAt).toBe(t0 + 1);
    expect(() => q.decide({ option: 'A' }, 'по таймауту', t0 + 2)).toThrow(DomainError);
  });

  test('после удержания человек отвечает обычным ответом', () => {
    const q = Question.ask(draft, t0);
    q.hold(t0 + 1);
    expect(q.answer({ option: 'B' }, t0 + 2)).toBe('answer');
    expect(q.status).toBe('answered');
  });

  test('удержать можно только открытый вопрос', () => {
    const q = Question.ask(draft, t0);
    q.decide({ option: 'A' }, 'по таймауту', t0 + 1);
    expect(() => q.hold(t0 + 2)).toThrow(DomainError);
  });
});

test('состояние сохраняется и восстанавливается', () => {
  const q = Question.ask(draft, t0);
  q.decide({ option: 'A' }, 'по таймауту', t0 + 1);
  q.answer({ text: 'нет, B' }, t0 + 2);
  expect(Question.restore(q.toState()).toState()).toEqual(q.toState());
});
