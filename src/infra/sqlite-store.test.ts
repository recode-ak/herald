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

  test('миграция v1 → v2: сессии сохраняются, название пишется', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herald-mig-'));
    const path = join(dir, 'v1.db');
    const v1 = new Database(path, { create: true });
    v1.run(`CREATE TABLE sessions (key TEXT PRIMARY KEY, person TEXT NOT NULL, host TEXT NOT NULL,
      project TEXT NOT NULL, root TEXT NOT NULL, last_seen_at INTEGER NOT NULL, status_text TEXT, status_at INTEGER)`);
    v1.run(`INSERT INTO sessions VALUES ('laptop:/x', 'nur', 'laptop', 'x', '/x', 100, NULL, NULL)`);
    v1.run('PRAGMA user_version = 1');
    v1.close();

    const store = SqliteStore.open(path);
    const s = store.session('laptop:/x')!;
    expect(s.title).toBeUndefined();
    s.setTitle('ревью', 200);
    store.saveSession(s);
    expect(store.session('laptop:/x')?.title).toBe('ревью');
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
  test('полное состояние сохраняется: hold, решение, поздние ответы', () => {
    const store = SqliteStore.open(':memory:');
    const q = question();
    store.saveQuestion(q);
    expect(store.question('q1')?.toState()).toEqual(q.toState());

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
