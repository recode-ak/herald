import { describe, expect, test } from 'bun:test';
import { Question } from '../domain/question.ts';
import { Session } from '../domain/session.ts';
import { Messages } from './messages.ts';

/** UTC+5: 0 мс → 05:00. */
const ZONE = 'Asia/Oral';

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

describe('Messages — HTML', () => {
  const session = Session.open({ person: 'nur', host: 'laptop', root: '/x/u7-school' }, 0);

  test('уведомление: шапка жирным, текст агента — из Markdown', () => {
    expect(Messages.notifyHtml(session, '**Готово** <x>')).toBe('<b>[laptop · u7-school]</b>\n<b>Готово</b> &lt;x&gt;');
  });

  test('вопрос: текст жирным, варианты отдельными строками, подсказка курсивом; решение — экранировано', () => {
    const q = Question.ask(
      {
        id: 'q1',
        sessionKey: session.key,
        person: 'nur',
        text: 'Какую `БД`?',
        options: [
          { id: 'A', text: 'SQLite' },
          { id: 'B', text: 'Postgres <15>' },
        ],
        recommended: 'A',
        timeoutMs: 180_000,
      },
      0,
    );
    expect(Messages.questionHtml(q, session, ZONE)).toBe(
      '<b>[laptop · u7-school]</b>\n❓ <b>Какую <code>БД</code>?</b>\n\n<b>A</b>: SQLite ⭐\n<b>B</b>: Postgres &lt;15&gt;\n\n<i>Ответь кнопкой или reply на это сообщение.</i>\n\n⏳ На раздумье 3 мин — до 05:03, потом агент решит сам.',
    );
    q.decide({ option: 'B' }, 'по <таймауту>', 1);
    expect(Messages.questionHtml(q, session, ZONE)).toEndWith(
      '\n\n🤖 Принят B по &lt;таймауту&gt;. Кнопки — чтобы переиграть.',
    );
  });
});

describe('Messages.span', () => {
  test.each([
    [0, '0 с'],
    [1, '1 с'],
    [45_000, '45 с'],
    [90_000, '1 мин 30 с'],
    [180_000, '3 мин'],
    [3_600_000, '1 ч'],
    [5_430_000, '1 ч 30 мин'],
    [2 * 86_400_000, '48 ч'],
  ])('%d мс → %s', (ms, text) => {
    expect(Messages.span(ms)).toBe(text);
  });
});

describe('Messages — срок вопроса и «Жди меня»', () => {
  const session = Session.open({ person: 'nur', host: 'laptop', root: '/x/u7-school' }, 0);
  const draft = {
    id: 'q1',
    sessionKey: session.key,
    person: 'nur',
    text: 'Какую БД?',
    options: [{ id: 'A', text: 'SQLite' }],
    recommended: 'A',
  };
  const labels = (q: Question) => Messages.questionButtons(q).flatMap((row) => row.map((b) => b.text));

  test('с таймаутом: время на раздумье и срок в поясе; есть «Жди меня»', () => {
    const q = Question.ask({ ...draft, timeoutMs: 180_000 }, 0);
    expect(Messages.question(q, session, ZONE)).toEndWith(
      '\n\n⏳ На раздумье 3 мин — до 05:03, потом агент решит сам.',
    );
    expect(labels(q)).toEqual(['A ⭐', 'Жди меня']);
  });

  test('срок на другой день — с датой', () => {
    const q = Question.ask({ ...draft, timeoutMs: 86_400_000 }, 0);
    expect(Messages.question(q, session, ZONE)).toContain('На раздумье 24 ч — до 02.01 05:00,');
  });

  test('без таймаута: время не ограничено; «Жди меня» нет — агент и так ждёт', () => {
    const q = Question.ask(draft, 0);
    expect(Messages.question(q, session, ZONE)).toEndWith('\n\n⏳ Время не ограничено: агент ждёт твоего ответа.');
    expect(labels(q)).toEqual(['A ⭐']);
  });

  test('после «Жди меня» — пауза вместо срока, кнопки «Жди меня» нет', () => {
    const q = Question.ask({ ...draft, timeoutMs: 180_000 }, 0);
    q.hold(1);
    const text = Messages.question(q, session, ZONE);
    expect(text).toEndWith('\n\n⏸ Агент ждёт твоего ответа.');
    expect(text).not.toContain('⏳');
    expect(labels(q)).toEqual(['A ⭐']);
  });

  test('ответ в терминале — пометка, кнопок нет', () => {
    const q = Question.ask({ ...draft, timeoutMs: 180_000 }, 0);
    q.answerInTerminal({ option: 'A' }, 1);
    expect(Messages.question(q, session, ZONE)).toEndWith('\n\n👤 Принят A (в терминале).');
    expect(labels(q)).toEqual([]);
  });

  test('решённый вопрос — без срока', () => {
    const q = Question.ask({ ...draft, timeoutMs: 180_000 }, 0);
    q.decide({ option: 'A' }, 'по таймауту', 180_000);
    expect(Messages.question(q, session, ZONE)).not.toContain('⏳');
  });
});
