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
    expect(labels(q)).toEqual(['A ⭐', 'Жди меня', '🖥 В терминал']);
  });

  test('срок на другой день — с датой', () => {
    const q = Question.ask({ ...draft, timeoutMs: 86_400_000 }, 0);
    expect(Messages.question(q, session, ZONE)).toContain('На раздумье 24 ч — до 02.01 05:00,');
  });

  test('без таймаута: время не ограничено; «Жди меня» нет — агент и так ждёт', () => {
    const q = Question.ask(draft, 0);
    expect(Messages.question(q, session, ZONE)).toEndWith('\n\n⏳ Время не ограничено: агент ждёт твоего ответа.');
    expect(labels(q)).toEqual(['A ⭐', '🖥 В терминал']);
  });

  test('после «Жди меня» — пауза вместо срока, кнопки «Жди меня» нет', () => {
    const q = Question.ask({ ...draft, timeoutMs: 180_000 }, 0);
    q.hold(1);
    const text = Messages.question(q, session, ZONE);
    expect(text).toEndWith('\n\n⏸ Агент ждёт твоего ответа.');
    expect(text).not.toContain('⏳');
    expect(labels(q)).toEqual(['A ⭐', '🖥 В терминал']);
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

describe('Messages — пачка', () => {
  const session = Session.open({ person: 'nur', host: 'laptop', root: '/x/u7-school' }, 0);
  const batch = () =>
    Question.ask(
      {
        id: 'q1',
        sessionKey: session.key,
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
          { text: 'Порт?', options: [] },
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
      },
      0,
    );
  const buttons = (q: Question, n?: number) => Messages.questionButtons(q, n).flat();

  test('пункт: «Вопрос N из M», варианты пункта, срок пачки; кнопки пункта, «вся пачка», «В терминал»', () => {
    const q = batch();
    q.answer({ option: 'B' }, 1, 1);
    expect(Messages.question(q, session, ZONE, 3)).toBe(
      '[laptop · u7-school]\nВопрос 3 из 3\n❓ Логи?\n\nA: stderr\nB: файл ⭐\n\nОтветь кнопкой или reply на это сообщение.' +
        '\n\n⏳ На раздумье 3 мин — до 05:03, потом агент решит сам.',
    );
    expect(Messages.questionHtml(q, session, ZONE, 2)).toStartWith(
      '<b>[laptop · u7-school]</b>\n<i>Вопрос 2 из 3</i>\n',
    );
    expect(buttons(q, 3)).toEqual([
      { text: 'A', data: 'b:q1:3:A' },
      { text: 'B ⭐', data: 'b:q1:3:B' },
      { text: 'Жди меня (вся пачка)', data: 'h:q1' },
      { text: '🖥 В терминал', data: 't:q1' },
    ]);
    expect(Messages.question(q, session, ZONE, 1)).toEndWith('\n\n👤 Принят B.');
    expect(buttons(q, 1)).toEqual([]);
  });

  test('одиночный вопрос: «из» нет, кнопка «В терминал» есть', () => {
    const q = Question.ask(
      { id: 'q2', sessionKey: session.key, person: 'nur', text: 'БД?', options: [{ id: 'A', text: 'SQLite' }] },
      0,
    );
    expect(Messages.question(q, session, ZONE)).not.toContain('из');
    expect(buttons(q)).toEqual([
      { text: 'A', data: 'a:q2:A' },
      { text: '🖥 В терминал', data: 't:q2' },
    ]);
  });

  test('переведён в терминал: кнопок нет, вместо подсказки и срока — строка о терминале', () => {
    const q = batch();
    q.moveToTerminal(1);
    const text = Messages.question(q, session, ZONE, 1);
    expect(text).toBe(
      '[laptop · u7-school]\nВопрос 1 из 3\n❓ База?\n\nA: SQLite ⭐\nB: JSON\n\n🖥 Переведено в терминал — ответь там; reply здесь тоже примется.',
    );
    expect(buttons(q, 1)).toEqual([]);
  });

  test('ответы в терминале на неотправленные пункты — итогом на последнем отправленном', () => {
    const q = batch();
    q.moveToTerminal(1);
    q.answerInTerminal(
      [
        { item: 1, choice: { option: 'A' } },
        { item: 2, choice: { text: '80' } },
        { item: 3, choice: { option: 'B' } },
      ],
      2,
    );
    expect(Messages.question(q, session, ZONE, 1, { sent: 1 })).toEndWith(
      '\n\n👤 Принят A (в терминале).\n\n👤 В терминале:\n2. Порт? — 80\n3. Логи? — B: файл',
    );
  });

  test('итог решения агента по неотправленным пунктам; reply — указанием', () => {
    const q = batch();
    q.answer({ option: 'B' }, 1, 1);
    q.decide([{ item: 2, choice: { text: '80' } }], 'по таймауту', 2);
    expect(Messages.decidedRest(q, session, 2)).toBe(
      '[laptop · u7-school]\n🤖 Агент решил по таймауту остальные вопросы:\n3. Логи? — B: файл\n\nПереиграть — reply на это сообщение: уйдёт указанием.',
    );
    expect(Messages.decidedRestHtml(q, session, 2)).toStartWith('<b>[laptop · u7-school]</b>\n🤖 ');
  });

  test('тексты входящих: ответы пачки, поздний ответ пункта, перевод в терминал', () => {
    const q = batch();
    q.answer({ option: 'B' }, 1, 1);
    q.answer({ text: '80' }, 2, 2);
    q.answer({ option: 'A' }, 3, 3);
    expect(Messages.answersText(q)).toBe('1. База? — B: JSON\n2. Порт? — 80\n3. Логи? — A: stderr');
    expect(Messages.itemAnswerText(q, 3, { by: 'human', option: 'B', at: 4 })).toBe('3. Логи? — B: файл');

    const t = batch();
    t.answer({ option: 'B' }, 1, 1);
    t.moveToTerminal(2);
    expect(Messages.toTerminalText(t)).toBe(
      [
        'Человек перевёл вопрос q1 в терминал: задай неотвеченные пункты здесь, своим UI, и закрой ответы инструментом answered (CLI — herald answered).',
        '',
        'Уже ответил:',
        '1. База? — B: JSON',
        '',
        'Спросить:',
        '2. Порт? — свободный ответ',
        '3. Логи? — варианты: A: stderr; B: файл ⭐',
      ].join('\n'),
    );
  });
});
