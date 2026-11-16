import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxItem } from '../domain/inbox.ts';
import { Question } from '../domain/question.ts';
import { Session } from '../domain/session.ts';
import { SqliteStore } from './sqlite-store.ts';

const ref = { host: 'laptop', root: '/home/nur/dev/u7-school', person: 'nur' };

function question(id = 'q1', sessionKey = Session.keyOf(ref)) {
  return Question.ask(
    {
      id,
      sessionKey,
      person: 'nur',
      text: 'Какую БД?',
      options: [
        { id: 'A', text: 'SQLite' },
        { id: 'B', text: 'Postgres' },
      ],
      recommended: 'A',
      timeoutMs: 180_000,
    },
    100,
  );
}

function item(id: string, createdAt: number, sessionKey = Session.keyOf(ref)) {
  return InboxItem.create({ id, sessionKey, person: 'nur', kind: 'directive', text: `указание ${id}` }, createdAt);
}

describe('SqliteStore: сессии', () => {
  test('сохранение и чтение со статусом; повторное сохранение — обновление', () => {
    const store = SqliteStore.open(':memory:');
    const s = Session.open(ref, 100);
    store.saveSession(s);
    expect(store.session(s.key)?.toState()).toEqual(s.toState());

    s.setStatus('Фаза 2', 200);
    s.setTitle('ревью', 210);
    s.close(220);
    store.saveSession(s);
    expect(store.session(s.key)?.toState()).toEqual(s.toState());
    expect(store.session('нет')).toBeUndefined();
  });

  test('миграция с v1: сессии и вопросы сохраняются, название пишется, у старых вопросов срока нет', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herald-mig-'));
    const path = join(dir, 'v1.db');
    const v1 = new Database(path, { create: true });
    v1.run(`CREATE TABLE sessions (key TEXT PRIMARY KEY, person TEXT NOT NULL, host TEXT NOT NULL,
      project TEXT NOT NULL, root TEXT NOT NULL, last_seen_at INTEGER NOT NULL, status_text TEXT, status_at INTEGER)`);
    v1.run(`INSERT INTO sessions VALUES ('laptop:/x', 'nur', 'laptop', 'x', '/x', 100, NULL, NULL)`);
    v1.run(`CREATE TABLE questions (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, person TEXT NOT NULL,
      text TEXT NOT NULL, options TEXT NOT NULL, recommended TEXT, status TEXT NOT NULL, asked_at INTEGER NOT NULL,
      held_at INTEGER, resolution TEXT, late_answers TEXT NOT NULL)`);
    v1.run(`INSERT INTO questions VALUES ('q0', 'laptop:/x', 'nur', 'БД?', '[]', NULL, 'open', 50, NULL, NULL, '[]')`);
    v1.run('PRAGMA user_version = 1');
    v1.close();

    const store = SqliteStore.open(path);
    const s = store.session('laptop:/x')!;
    expect(s.title).toBeUndefined();
    s.setTitle('ревью', 200);
    store.saveSession(s);
    expect(store.session('laptop:/x')?.title).toBe('ревью');
    expect(store.question('q0')?.deadlineAt).toBeUndefined();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('сессии человека — недавние первыми, чужие не попадают', () => {
    const store = SqliteStore.open(':memory:');
    store.saveSession(Session.open({ ...ref, root: '/a' }, 100));
    store.saveSession(Session.open({ ...ref, root: '/b' }, 300));
    store.saveSession(Session.open({ ...ref, root: '/c', person: 'ann' }, 200));
    expect(store.sessionsOf('nur').map((s) => s.project)).toEqual(['b', 'a']);
  });
});

describe('SqliteStore: вопросы', () => {
  test('полное состояние сохраняется: срок, hold, решение, поздние ответы', () => {
    const store = SqliteStore.open(':memory:');
    const q = question();
    store.saveQuestion(q);
    expect(store.question('q1')?.toState()).toEqual(q.toState());
    expect(store.question('q1')?.deadlineAt).toBe(100 + 180_000);

    q.decide({ option: 'A' }, 'по таймауту', 200);
    q.answer({ text: 'лучше Postgres' }, 300);
    store.saveQuestion(q);
    expect(store.question('q1')?.toState()).toEqual(q.toState());
    expect(store.question('нет')).toBeUndefined();
  });
});

describe('SqliteStore: входящие', () => {
  test('ящик — непрочитанные по порядку; прочитанные — только по include', () => {
    const store = SqliteStore.open(':memory:');
    store.saveInboxItem(item('i2', 200));
    store.saveInboxItem(item('i1', 100));
    store.saveInboxItem(item('x', 50, 'other:/x'));

    const inbox = store.inbox(Session.keyOf(ref));
    expect(inbox.pending().map((i) => i.id)).toEqual(['i1', 'i2']);

    for (const read of inbox.ack(['i1'], 300)) store.saveInboxItem(read);
    expect(
      store
        .inbox(Session.keyOf(ref))
        .pending()
        .map((i) => i.id),
    ).toEqual(['i2']);

    const again = store.inbox(Session.keyOf(ref), ['i1']);
    expect(again.ack(['i1'], 400)).toEqual([]);
  });

  test('поля входящего сохраняются', () => {
    const store = SqliteStore.open(':memory:');
    const answer = InboxItem.create(
      { id: 'a1', sessionKey: 's', person: 'nur', kind: 'answer', text: 'SQLite', questionId: 'q1', option: 'A' },
      100,
    );
    store.saveInboxItem(answer);
    expect(store.inbox('s').pending()[0]?.toState()).toEqual(answer.toState());
  });
});

describe('SqliteStore: связи сообщений', () => {
  test('по chat_id и message_id, по вопросу, по входящему', () => {
    const store = SqliteStore.open(':memory:');
    store.saveLink({ chatId: 111, messageId: 1, sessionKey: 's', questionId: 'q1' });
    store.saveLink({ chatId: 111, messageId: 2, sessionKey: 's' });
    store.saveLink({ chatId: 111, messageId: 3, sessionKey: 's', inboxId: 'i1' });
    store.saveLink({ chatId: 222, messageId: 1, sessionKey: 't' });

    expect(store.link(111, 1)).toEqual({ chatId: 111, messageId: 1, sessionKey: 's', questionId: 'q1' });
    expect(store.link(111, 2)).toEqual({ chatId: 111, messageId: 2, sessionKey: 's' });
    expect(store.link(222, 1)?.sessionKey).toBe('t');
    expect(store.link(111, 9)).toBeUndefined();
    expect(store.linksOfQuestion('q1').map((l) => l.messageId)).toEqual([1]);
    expect(store.linksOfInbox('i1').map((l) => l.messageId)).toEqual([3]);
  });
});

describe('SqliteStore: время связи (v5)', () => {
  const createdAt = (path: string) => {
    const raw = new Database(path, { readonly: true });
    const rows = raw
      .query<{ message_id: number; created_at: number }, []>(
        'SELECT message_id, created_at FROM message_links ORDER BY message_id',
      )
      .all();
    raw.close();
    return rows;
  };

  test('миграция с v4: старые связи живы и получают время миграции; новая — время сохранения', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herald-mig-'));
    const path = join(dir, 'v4.db');
    const v4 = new Database(path, { create: true });
    v4.run(`CREATE TABLE message_links (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
      session_key TEXT NOT NULL, question_id TEXT, inbox_id TEXT, PRIMARY KEY (chat_id, message_id))`);
    v4.run(`INSERT INTO message_links VALUES (111, 1, 'laptop:/x', 'q1', NULL)`);
    v4.run('PRAGMA user_version = 4');
    v4.close();

    const before = Date.now();
    const store = SqliteStore.open(path);
    expect(store.link(111, 1)).toEqual({ chatId: 111, messageId: 1, sessionKey: 'laptop:/x', questionId: 'q1' });
    expect(store.linksOfQuestion('q1')).toHaveLength(1);
    store.saveLink({ chatId: 111, messageId: 2, sessionKey: 'laptop:/x' });
    const after = Date.now();
    store.close();

    const rows = createdAt(path);
    expect(rows.map((r) => r.message_id)).toEqual([1, 2]);
    for (const r of rows) {
      expect(r.created_at).toBeGreaterThanOrEqual(before - 1);
      expect(r.created_at).toBeLessThanOrEqual(after + 1);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('SqliteStore: очистка', () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const cutoff = now - 14 * DAY;
  const old = now - 20 * DAY;
  const fresh = now - DAY;
  const live = { ...ref, root: '/live' };
  const dead = { ...ref, root: '/dead' };
  const liveKey = Session.keyOf(live);
  const deadKey = Session.keyOf(dead);

  /** Вопрос сессии, заданный в `at`; `answered` — человек ответил сразу. */
  function asked(store: SqliteStore, id: string, sessionKey: string, at: number, answered: boolean) {
    const q = question(id, sessionKey);
    const state = { ...q.toState(), askedAt: at, deadlineAt: at + 180_000 };
    const restored = Question.restore(state);
    if (answered) restored.answer({ option: 'A' }, at + 1);
    store.saveQuestion(restored);
    store.saveLink({ chatId: 111, messageId: Number(id.slice(1)), sessionKey, questionId: id });
  }

  /** Входящее сессии, созданное в `at`; `readAt` — прочитано. */
  function posted(store: SqliteStore, id: string, sessionKey: string, at: number, readAt?: number) {
    const i = item(id, at, sessionKey);
    store.saveInboxItem(readAt === undefined ? i : InboxItem.restore({ ...i.toState(), readAt }));
    store.saveLink({ chatId: 111, messageId: 500 + Number(id.slice(1)), sessionKey, inboxId: id });
  }

  function seed() {
    const store = SqliteStore.open(':memory:');
    store.saveSession(Session.open({ ...live }, fresh));
    store.saveSession(Session.open({ ...dead }, old));
    store.setTelegramOffset(42);
    // мёртвая сессия: всё уходит вместе с ней, даже открытое и непрочитанное
    asked(store, 'q1', deadKey, fresh, false);
    posted(store, 'i1', deadKey, fresh);
    store.saveLink({ chatId: 111, messageId: 900, sessionKey: deadKey });
    store.setChatTarget(111, deadKey);
    // живая сессия
    asked(store, 'q2', liveKey, old, true); // решён давно — удаляется
    asked(store, 'q3', liveKey, fresh, true); // решён недавно — остаётся
    asked(store, 'q4', liveKey, old, false); // открыт давно — остаётся
    posted(store, 'i2', liveKey, old, old); // прочитан давно — удаляется
    posted(store, 'i3', liveKey, old, fresh); // прочитан недавно — остаётся
    posted(store, 'i4', liveKey, old); // не прочитан — остаётся
    store.saveLink({ chatId: 111, messageId: 901, sessionKey: liveKey }); // уведомление — свежее
    store.setChatTarget(222, liveKey);
    return store;
  }

  test('мёртвая сессия уходит со всем своим; у живой — решённое и прочитанное старше срока', () => {
    const store = seed();
    const report = store.purge(cutoff);

    expect(report.deleted).toEqual({ sessions: 1, questions: 2, inbox: 2, links: 5, targets: 1 });
    expect(report.remaining).toEqual({ sessions: 1, questions: 2, inbox: 2, links: 5, targets: 1 });
    expect(report.dbBytes).toBeGreaterThan(0);

    expect(store.session(deadKey)).toBeUndefined();
    expect(store.session(liveKey)).toBeDefined();
    expect(['q1', 'q2', 'q3', 'q4'].map((id) => store.question(id) !== undefined)).toEqual([false, false, true, true]);
    expect(store.inbox(deadKey, ['i1']).pending()).toEqual([]);
    expect(
      store
        .inbox(liveKey, ['i2', 'i3', 'i4'])
        .ack(['i3', 'i4'], now)
        .map((i) => i.id),
    ).toEqual(['i4']);
    expect(() => store.inbox(liveKey, ['i2']).ack(['i2'], now)).toThrow();

    expect(store.link(111, 1)).toBeUndefined(); // q1
    expect(store.link(111, 2)).toBeUndefined(); // q2
    expect(store.link(111, 501)).toBeUndefined(); // i1
    expect(store.link(111, 502)).toBeUndefined(); // i2
    expect(store.link(111, 900)).toBeUndefined(); // уведомление мёртвой сессии
    expect([3, 4, 503, 504, 901].map((m) => store.link(111, m) !== undefined)).toEqual([true, true, true, true, true]);

    expect(store.chatTarget(111)).toBeUndefined();
    expect(store.chatTarget(222)).toBe(liveKey);
    expect(store.telegramOffset()).toBe(42);
  });

  test('связь уведомления — по своему времени; связи оставшихся вопросов и входящих живут с ними', () => {
    const store = SqliteStore.open(':memory:');
    const later = Date.now() + DAY;
    store.saveSession(Session.open({ ...live }, later));
    asked(store, 'q4', liveKey, later, false);
    posted(store, 'i4', liveKey, later);
    store.saveLink({ chatId: 111, messageId: 901, sessionKey: liveKey });

    const report = store.purge(Date.now() + 1000);
    expect(report.deleted).toEqual({ sessions: 0, questions: 0, inbox: 0, links: 1, targets: 0 });
    expect(store.link(111, 901)).toBeUndefined();
    expect(store.link(111, 4)).toBeDefined();
    expect(store.link(111, 504)).toBeDefined();
  });

  test('dryRun — те же счётчики (и «останется»), ничего не удалено; повторная очистка — нули', () => {
    const store = seed();
    const dry = store.purge(cutoff, { dryRun: true });
    expect(dry.deleted).toEqual({ sessions: 1, questions: 2, inbox: 2, links: 5, targets: 1 });
    expect(dry.remaining).toEqual({ sessions: 1, questions: 2, inbox: 2, links: 5, targets: 1 });
    expect(store.session(deadKey)).toBeDefined();

    store.purge(cutoff);
    expect(store.purge(cutoff).deleted).toEqual({ sessions: 0, questions: 0, inbox: 0, links: 0, targets: 0 });
  });
});

describe('SqliteStore: offset Telegram и транзакции', () => {
  test('offset по умолчанию 0, затем сохраняется', () => {
    const store = SqliteStore.open(':memory:');
    expect(store.telegramOffset()).toBe(0);
    store.setTelegramOffset(42);
    store.setTelegramOffset(43);
    expect(store.telegramOffset()).toBe(43);
  });

  test('исключение в транзакции откатывает изменения', () => {
    const store = SqliteStore.open(':memory:');
    expect(() =>
      store.transaction(() => {
        store.setTelegramOffset(7);
        throw new Error('сбой');
      }),
    ).toThrow('сбой');
    expect(store.telegramOffset()).toBe(0);
  });
});

describe('SqliteStore: адресат чата', () => {
  test('выбранная сессия чата сохраняется и сбрасывается', () => {
    const store = SqliteStore.open(':memory:');
    expect(store.chatTarget(111)).toBeUndefined();
    store.setChatTarget(111, 'laptop:/a');
    store.setChatTarget(222, 'pc:/b');
    expect(store.chatTarget(111)).toBe('laptop:/a');
    store.setChatTarget(111, undefined);
    expect(store.chatTarget(111)).toBeUndefined();
    expect(store.chatTarget(222)).toBe('pc:/b');
  });
});

describe('SqliteStore: файл', () => {
  const dir = mkdtempSync(join(tmpdir(), 'herald-store-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('схема создаётся при старте, WAL; повторное открытие сохраняет данные', () => {
    const path = join(dir, 'herald.db');
    const first = SqliteStore.open(path);
    expect(first.journalMode()).toBe('wal');
    first.saveSession(Session.open(ref, 100));
    first.close();

    const reopened = SqliteStore.open(path);
    expect(reopened.session(Session.keyOf(ref))?.project).toBe('u7-school');
    reopened.close();
  });
});
