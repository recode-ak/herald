import { describe, expect, test } from 'bun:test';
import { Question } from '../domain/question.ts';
import { Session } from '../domain/session.ts';
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
      },
      0,
    );
    expect(Messages.questionHtml(q, session)).toBe(
      '<b>[laptop · u7-school]</b>\n❓ <b>Какую <code>БД</code>?</b>\n\n<b>A</b>: SQLite ⭐\n<b>B</b>: Postgres &lt;15&gt;\n\n<i>Ответь кнопкой или reply на это сообщение.</i>',
    );
    q.decide({ option: 'B' }, 'по <таймауту>', 1);
    expect(Messages.questionHtml(q, session)).toEndWith(
      '\n\n🤖 Принят B по &lt;таймауту&gt;. Кнопки — чтобы переиграть.',
    );
  });
});
