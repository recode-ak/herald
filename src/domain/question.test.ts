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
  timeoutMs: 180_000,
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

  test('таймаут задаёт срок решения агента; без таймаута срока нет', () => {
    expect(Question.ask(draft, t0).deadlineAt).toBe(t0 + 180_000);
    expect(Question.ask({ ...draft, timeoutMs: undefined }, t0).deadlineAt).toBeUndefined();
  });

  test('таймаут — целое число мс ≥ 0 (0 — агент решит сразу)', () => {
    expect(Question.ask({ ...draft, timeoutMs: 0 }, t0).deadlineAt).toBe(t0);
    for (const timeoutMs of [-1, 1.5, Number.NaN]) {
      expect(() => Question.ask({ ...draft, timeoutMs }, t0)).toThrow(DomainError);
    }
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

  test('вопрос без таймаута агент не решает: ждёт ответа человека', () => {
    const q = Question.ask({ ...draft, timeoutMs: undefined }, t0);
    expect(() => q.decide({ option: 'A' }, 'по таймауту', t0 + 1)).toThrow('без таймаута');
    expect(q.status).toBe('open');
  });
});

describe('Question — ответ в терминале', () => {
  test('агент отмечает ответ человека в терминале: open → answered, via terminal', () => {
    const q = Question.ask({ ...draft, timeoutMs: undefined }, t0);
    q.answerInTerminal({ option: 'B' }, t0 + 1);
    expect(q.status).toBe('answered');
    expect(q.resolution).toEqual({ by: 'human', option: 'B', via: 'terminal', at: t0 + 1 });
  });

  test('и после «Жди меня»; свободный текст', () => {
    const q = Question.ask(draft, t0);
    q.hold(t0 + 1);
    q.answerInTerminal({ text: ' позже ' }, t0 + 2);
    expect(q.resolution).toEqual({ by: 'human', text: 'позже', via: 'terminal', at: t0 + 2 });
  });

  test('только открытый вопрос и только известный вариант', () => {
    const q = Question.ask(draft, t0);
    expect(() => q.answerInTerminal({ option: 'C' }, t0)).toThrow(DomainError);
    q.answer({ option: 'A' }, t0 + 1);
    expect(() => q.answerInTerminal({ option: 'B' }, t0 + 2)).toThrow('уже решён');
    expect(q.resolution?.option).toBe('A');
    expect(q.lateAnswers).toEqual([]);
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

const batch: QuestionDraft = {
  id: 'q2',
  sessionKey: 'h:/x',
  person: 'nur',
  items: [
    {
      text: 'База?',
      options: [
        { id: 'A', text: 'SQLite' },
        { id: 'B', text: 'JSON' },
      ],
      recommended: 'A',
    },
    { text: 'Порт?', options: [], recommended: undefined },
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

describe('Question — пачка пунктов', () => {
  test('одиночный вопрос — пачка из одного пункта; плоские поля — первый пункт', () => {
    const q = Question.ask(draft, t0);
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toEqual({
      text: 'Хранить в SQLite?',
      options: draft.options,
      recommended: 'A',
      lateAnswers: [],
    });
  });

  test('пачка: 1–10 пунктов, каждый проверяется как одиночный вопрос', () => {
    expect(Question.ask(batch, t0).items.map((i) => i.text)).toEqual(['База?', 'Порт?', 'Логи?']);
    expect(() => Question.ask({ ...batch, items: [] }, t0)).toThrow('1–10');
    const eleven = Array.from({ length: 11 }, (_, n) => ({ text: `${n}`, options: [] }));
    expect(() => Question.ask({ ...batch, items: eleven }, t0)).toThrow('1–10');
    expect(() => Question.ask({ ...batch, items: [{ text: 'x', options: [], recommended: 'A' }] }, t0)).toThrow(
      'пункт 1',
    );
  });

  test('ответы по пунктам: вопрос открыт, пока не отвечены все; текущий — первый неотвеченный', () => {
    const q = Question.ask(batch, t0);
    expect(q.current).toBe(1);
    expect(q.answer({ option: 'B' }, t0 + 1, 1)).toBe('answer');
    expect(q.status).toBe('open');
    expect(q.current).toBe(2);
    q.answer({ text: '4518' }, t0 + 2, 2);
    q.answer({ option: 'A' }, t0 + 3, 3);
    expect(q.status).toBe('answered');
    expect(q.current).toBeUndefined();
    expect(q.items.map((i) => i.resolution?.option ?? i.resolution?.text)).toEqual(['B', '4518', 'A']);
  });

  test('повторный ответ на пункт открытого вопроса заменяет прежний; несуществующий пункт — ошибка', () => {
    const q = Question.ask(batch, t0);
    q.answer({ option: 'A' }, t0 + 1, 1);
    expect(q.answer({ option: 'B' }, t0 + 2, 1)).toBe('answer');
    expect(q.items[0]?.resolution?.option).toBe('B');
    expect(q.items[0]?.lateAnswers).toEqual([]);
    expect(() => q.answer({ option: 'A' }, t0, 4)).toThrow('пункта 4 нет');
    expect(() => q.answer({ text: 'x' }, t0, 0)).toThrow('пункта 0 нет');
  });

  test('ответ на пункт решённого вопроса — поздний этого пункта', () => {
    const q = Question.ask(batch, t0);
    q.decide([{ item: 2, choice: { text: '80' } }], 'по таймауту', t0 + 1);
    expect(q.answer({ option: 'B' }, t0 + 2, 3)).toBe('late');
    expect(q.items[2]?.resolution?.option).toBe('B');
    expect(q.items[2]?.lateAnswers).toEqual([{ by: 'human', option: 'B', at: t0 + 2 }]);
  });

  test('decide: неотвеченные — ответ агента или рекомендованный; ответы человека остаются', () => {
    const q = Question.ask(batch, t0);
    q.answer({ option: 'B' }, t0 + 1, 1);
    q.decide(
      [
        { item: 1, choice: { option: 'A' } },
        { item: 2, choice: { text: '80' } },
      ],
      'по таймауту',
      t0 + 2,
    );
    expect(q.status).toBe('decided');
    expect(q.items.map((i) => i.resolution)).toEqual([
      { by: 'human', option: 'B', at: t0 + 1 },
      { by: 'agent', text: '80', reason: 'по таймауту', at: t0 + 2 },
      { by: 'agent', option: 'B', reason: 'по таймауту', at: t0 + 2 },
    ]);
  });

  test('decide: у неотвеченного пункта нет ни ответа агента, ни рекомендованного — ошибка с номером', () => {
    const q = Question.ask(batch, t0);
    expect(() => q.decide([], 'по таймауту', t0 + 1)).toThrow('пункт 2');
    expect(q.status).toBe('open');
    expect(q.items.every((i) => i.resolution === undefined)).toBe(true);
  });

  test('одиночный decide с вариантом — как прежде; без варианта — рекомендованный', () => {
    const q = Question.ask(draft, t0);
    q.decide([], 'по таймауту', t0 + 1);
    expect(q.resolution).toEqual({ by: 'agent', option: 'A', reason: 'по таймауту', at: t0 + 1 });
  });

  test('ответ в терминале по пунктам: отвечены все — answered', () => {
    const q = Question.ask(batch, t0);
    q.answer({ option: 'A' }, t0 + 1, 1);
    q.answerInTerminal([{ item: 2, choice: { text: '80' } }], t0 + 2);
    expect(q.status).toBe('open');
    q.answerInTerminal([{ item: 3, choice: { option: 'A' } }], t0 + 3);
    expect(q.status).toBe('answered');
    expect(q.items[2]?.resolution).toEqual({ by: 'human', option: 'A', via: 'terminal', at: t0 + 3 });
  });
});

describe('Question — перевод в терминал', () => {
  test('только открытый; повтор — без ошибки, время прежнее; решать агенту нельзя', () => {
    const q = Question.ask(batch, t0);
    q.moveToTerminal(t0 + 1);
    q.moveToTerminal(t0 + 2);
    expect(q.terminalAt).toBe(t0 + 1);
    expect(q.status).toBe('open');
    expect(() => q.decide([], 'по таймауту', t0 + 3)).toThrow('переведён в терминал');
    q.answer({ option: 'A' }, t0 + 4, 1);
    expect(q.items[0]?.resolution?.option).toBe('A');
  });

  test('решённый перевести нельзя', () => {
    const q = Question.ask(draft, t0);
    q.decide({ option: 'A' }, 'по таймауту', t0 + 1);
    expect(() => q.moveToTerminal(t0 + 2)).toThrow('уже решён');
  });

  test('состояние пачки с переводом сохраняется и восстанавливается', () => {
    const q = Question.ask(batch, t0);
    q.answer({ option: 'B' }, t0 + 1, 1);
    q.moveToTerminal(t0 + 2);
    expect(Question.restore(q.toState()).toState()).toEqual(q.toState());
  });
});
