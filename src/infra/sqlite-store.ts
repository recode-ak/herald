import { Database } from 'bun:sqlite';
import type { MessageLink, PurgeCounts, PurgeReport, Store } from '../app/store.ts';
import type { PersonId } from '../domain/access.ts';
import { Inbox, InboxItem, type InboxKind } from '../domain/inbox.ts';
import { Question, type QuestionItem, type QuestionStatus } from '../domain/question.ts';
import { Session } from '../domain/session.ts';

/**
 * Схема: v1 — таблицы, v2 — название сессии, v3 — закрытие окна, v4 — срок вопроса,
 * v5 — время связи с сообщением (для очистки; ставит SQLite при сохранении; ALTER не умеет DEFAULT-выражение —
 * таблица пересоздаётся), v6 — пачка вопросов: пункты JSON-ом (`items`; плоские поля — первый пункт, для чтения
 * старых строк), перевод в терминал, пункт в связи с сообщением. Версия — `PRAGMA user_version`; следующая — новый элемент массива.
 */
const MIGRATIONS = [
  `
  CREATE TABLE sessions (
    key TEXT PRIMARY KEY,
    person TEXT NOT NULL,
    host TEXT NOT NULL,
    project TEXT NOT NULL,
    root TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL,
    status_text TEXT,
    status_at INTEGER
  );
  CREATE INDEX sessions_person ON sessions (person, last_seen_at);

  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    person TEXT NOT NULL,
    text TEXT NOT NULL,
    options TEXT NOT NULL,
    recommended TEXT,
    status TEXT NOT NULL,
    asked_at INTEGER NOT NULL,
    held_at INTEGER,
    resolution TEXT,
    late_answers TEXT NOT NULL
  );

  CREATE TABLE inbox (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    person TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    question_id TEXT,
    option TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX inbox_unread ON inbox (session_key, read_at);

  CREATE TABLE message_links (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    session_key TEXT NOT NULL,
    question_id TEXT,
    inbox_id TEXT,
    PRIMARY KEY (chat_id, message_id)
  );
  CREATE INDEX message_links_question ON message_links (question_id);
  CREATE INDEX message_links_inbox ON message_links (inbox_id);

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  'ALTER TABLE sessions ADD COLUMN title TEXT;',
  'ALTER TABLE sessions ADD COLUMN closed_at INTEGER;',
  'ALTER TABLE questions ADD COLUMN deadline_at INTEGER;',
  `
  CREATE TABLE IF NOT EXISTS message_links (
    chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, session_key TEXT NOT NULL,
    question_id TEXT, inbox_id TEXT, PRIMARY KEY (chat_id, message_id)
  );
  CREATE TABLE message_links_v5 (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    session_key TEXT NOT NULL,
    question_id TEXT,
    inbox_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    PRIMARY KEY (chat_id, message_id)
  );
  INSERT INTO message_links_v5 (chat_id, message_id, session_key, question_id, inbox_id)
    SELECT chat_id, message_id, session_key, question_id, inbox_id FROM message_links;
  DROP TABLE message_links;
  ALTER TABLE message_links_v5 RENAME TO message_links;
  CREATE INDEX message_links_question ON message_links (question_id);
  CREATE INDEX message_links_inbox ON message_links (inbox_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY, session_key TEXT NOT NULL, person TEXT NOT NULL, text TEXT NOT NULL, options TEXT NOT NULL,
    recommended TEXT, status TEXT NOT NULL, asked_at INTEGER NOT NULL, held_at INTEGER, resolution TEXT,
    late_answers TEXT NOT NULL, deadline_at INTEGER
  );
  ALTER TABLE questions ADD COLUMN items TEXT;
  ALTER TABLE questions ADD COLUMN terminal_at INTEGER;
  ALTER TABLE message_links ADD COLUMN item INTEGER;
  CREATE INDEX questions_open ON questions (session_key, status, asked_at);
  `,
];

/** Сигнал отката транзакции пробной очистки (`dryRun`). */
const DRY_RUN = Symbol('dry-run');

interface SessionRow {
  key: string;
  person: string;
  host: string;
  project: string;
  root: string;
  last_seen_at: number;
  status_text: string | null;
  status_at: number | null;
  title: string | null;
  closed_at: number | null;
}

interface QuestionRow {
  id: string;
  session_key: string;
  person: string;
  text: string;
  options: string;
  recommended: string | null;
  status: QuestionStatus;
  asked_at: number;
  deadline_at: number | null;
  held_at: number | null;
  resolution: string | null;
  late_answers: string;
  items: string | null;
  terminal_at: number | null;
}

interface InboxRow {
  id: string;
  session_key: string;
  person: string;
  kind: InboxKind;
  text: string;
  question_id: string | null;
  option: string | null;
  created_at: number;
  read_at: number | null;
}

interface LinkRow {
  chat_id: number;
  message_id: number;
  session_key: string;
  question_id: string | null;
  inbox_id: string | null;
  item: number | null;
}

/** Хранилище на SQLite: одна таблица на сущность, состояние домена — через `toState`/`restore`. */
export class SqliteStore implements Store {
  private constructor(private readonly db: Database) {}

  /** Открыть (создать) базу: WAL, схема до последней версии. `:memory:` — для тестов. */
  static open(path: string): SqliteStore {
    const db = new Database(path, { create: true, strict: true });
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA busy_timeout = 5000');
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
    MIGRATIONS.slice(version).forEach((sql, i) => {
      db.transaction(() => {
        db.run(sql);
        db.run(`PRAGMA user_version = ${version + i + 1}`);
      })();
    });
    return new SqliteStore(db);
  }

  journalMode(): string {
    return this.db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode ?? '';
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  session(key: string): Session | undefined {
    const row = this.db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE key = ?').get(key);
    return row ? SqliteStore.toSession(row) : undefined;
  }

  saveSession(session: Session): void {
    const s = session.toState();
    this.db
      .query(
        `INSERT OR REPLACE INTO sessions (key, person, host, project, root, last_seen_at, status_text, status_at, title, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.key,
        s.person,
        s.host,
        s.project,
        s.root,
        s.lastSeenAt,
        s.status?.text ?? null,
        s.status?.at ?? null,
        s.title ?? null,
        s.closedAt ?? null,
      );
  }

  sessionsOf(person: PersonId): Session[] {
    return this.db
      .query<SessionRow, [string]>('SELECT * FROM sessions WHERE person = ? ORDER BY last_seen_at DESC, key')
      .all(person)
      .map(SqliteStore.toSession);
  }

  question(id: string): Question | undefined {
    const r = this.db.query<QuestionRow, [string]>('SELECT * FROM questions WHERE id = ?').get(id);
    return r ? SqliteStore.toQuestion(r) : undefined;
  }

  openQuestions(sessionKey: string): Question[] {
    return this.db
      .query<QuestionRow, [string]>(
        "SELECT * FROM questions WHERE session_key = ? AND status = 'open' ORDER BY asked_at, id",
      )
      .all(sessionKey)
      .map(SqliteStore.toQuestion);
  }

  saveQuestion(question: Question): void {
    const q = question.toState();
    const first = question.items[0];
    if (!first) throw new Error(`вопрос ${q.id} без пунктов`);
    this.db
      .query(
        `INSERT OR REPLACE INTO questions
           (id, session_key, person, text, options, recommended, status, asked_at, deadline_at, held_at, resolution,
            late_answers, items, terminal_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        q.id,
        q.sessionKey,
        q.person,
        first.text,
        JSON.stringify(first.options),
        first.recommended ?? null,
        q.status,
        q.askedAt,
        q.deadlineAt ?? null,
        q.heldAt ?? null,
        first.resolution ? JSON.stringify(first.resolution) : null,
        JSON.stringify(first.lateAnswers),
        JSON.stringify(q.items),
        q.terminalAt ?? null,
      );
  }

  saveInboxItem(item: InboxItem): void {
    const i = item.toState();
    this.db
      .query(
        `INSERT OR REPLACE INTO inbox (id, session_key, person, kind, text, question_id, option, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.id,
        i.sessionKey,
        i.person,
        i.kind,
        i.text,
        i.questionId ?? null,
        i.option ?? null,
        i.createdAt,
        i.readAt ?? null,
      );
  }

  inbox(sessionKey: string, include: readonly string[] = []): Inbox {
    const rows = this.db
      .query<InboxRow, [string, string]>(
        `SELECT * FROM inbox WHERE session_key = ?
           AND (read_at IS NULL OR id IN (SELECT value FROM json_each(?)))`,
      )
      .all(sessionKey, JSON.stringify(include));
    return new Inbox(
      sessionKey,
      rows.map((r) =>
        InboxItem.restore({
          id: r.id,
          sessionKey: r.session_key,
          person: r.person,
          kind: r.kind,
          text: r.text,
          ...(r.question_id !== null && { questionId: r.question_id }),
          ...(r.option !== null && { option: r.option }),
          createdAt: r.created_at,
          ...(r.read_at !== null && { readAt: r.read_at }),
        }),
      ),
    );
  }

  saveLink(link: MessageLink): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO message_links (chat_id, message_id, session_key, question_id, inbox_id, item)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        link.chatId,
        link.messageId,
        link.sessionKey,
        link.questionId ?? null,
        link.inboxId ?? null,
        link.item ?? null,
      );
  }

  link(chatId: number, messageId: number): MessageLink | undefined {
    const row = this.db
      .query<LinkRow, [number, number]>('SELECT * FROM message_links WHERE chat_id = ? AND message_id = ?')
      .get(chatId, messageId);
    return row ? SqliteStore.toLink(row) : undefined;
  }

  linksOfQuestion(questionId: string): MessageLink[] {
    return this.db
      .query<LinkRow, [string]>('SELECT * FROM message_links WHERE question_id = ? ORDER BY chat_id, message_id')
      .all(questionId)
      .map(SqliteStore.toLink);
  }

  linksOfInbox(inboxId: string): MessageLink[] {
    return this.db
      .query<LinkRow, [string]>('SELECT * FROM message_links WHERE inbox_id = ? ORDER BY chat_id, message_id')
      .all(inboxId)
      .map(SqliteStore.toLink);
  }

  chatTarget(chatId: number): string | undefined {
    return this.db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?').get(`target:${chatId}`)
      ?.value;
  }

  setChatTarget(chatId: number, sessionKey: string | undefined): void {
    if (sessionKey === undefined) this.db.query('DELETE FROM kv WHERE key = ?').run(`target:${chatId}`);
    else this.db.query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(`target:${chatId}`, sessionKey);
  }

  purge(cutoff: number, { dryRun = false }: { dryRun?: boolean } = {}): PurgeReport {
    let report: PurgeReport | undefined;
    const run = this.db.transaction(() => {
      const deleted = this.deleteExpired(cutoff);
      report = { deleted, remaining: this.counts(), dbBytes: this.dbBytes() };
      if (dryRun) throw DRY_RUN;
    });
    try {
      run.immediate();
    } catch (error) {
      if (error !== DRY_RUN) throw error;
    }
    if (!report) throw new Error('purge: нет итога');
    return report;
  }

  telegramOffset(): number {
    const row = this.db.query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'telegram_offset'").get();
    return row ? Number(row.value) : 0;
  }

  setTelegramOffset(offset: number): void {
    this.db.query("INSERT OR REPLACE INTO kv (key, value) VALUES ('telegram_offset', ?)").run(String(offset));
  }

  /**
   * Правила очистки (`docs/model.md`, «Хранение»). Живая сессия — обращалась не раньше границы; всё прочих
   * сессий (и сирот без сессии) удаляется. Сессии — последними: по ним отбираются остальные.
   */
  private deleteExpired(cutoff: number): PurgeCounts {
    const alive = 'SELECT key FROM sessions WHERE last_seen_at >= $cutoff';
    const run = (sql: string) => this.db.query<never, { cutoff: number }>(sql).run({ cutoff }).changes;
    const targets = run(`DELETE FROM kv WHERE key LIKE 'target:%' AND value NOT IN (${alive})`);
    const questions = run(
      `DELETE FROM questions WHERE session_key NOT IN (${alive}) OR (status <> 'open' AND asked_at < $cutoff)`,
    );
    const inbox = run(
      `DELETE FROM inbox WHERE session_key NOT IN (${alive}) OR (read_at IS NOT NULL AND read_at < $cutoff)`,
    );
    const links = run(
      `DELETE FROM message_links WHERE session_key NOT IN (${alive})
         OR (question_id IS NOT NULL AND question_id NOT IN (SELECT id FROM questions))
         OR (inbox_id IS NOT NULL AND inbox_id NOT IN (SELECT id FROM inbox))
         OR (question_id IS NULL AND inbox_id IS NULL AND created_at < $cutoff)`,
    );
    const sessions = run('DELETE FROM sessions WHERE last_seen_at < $cutoff');
    return { sessions, questions, inbox, links, targets };
  }

  private counts(): PurgeCounts {
    const count = (sql: string) => this.db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    return {
      sessions: count('SELECT count(*) AS n FROM sessions'),
      questions: count('SELECT count(*) AS n FROM questions'),
      inbox: count('SELECT count(*) AS n FROM inbox'),
      links: count('SELECT count(*) AS n FROM message_links'),
      targets: count("SELECT count(*) AS n FROM kv WHERE key LIKE 'target:%'"),
    };
  }

  private dbBytes(): number {
    const pages = this.db.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count ?? 0;
    const size = this.db.query<{ page_size: number }, []>('PRAGMA page_size').get()?.page_size ?? 0;
    return pages * size;
  }

  private static toSession(r: SessionRow): Session {
    return Session.restore({
      key: r.key,
      person: r.person,
      host: r.host,
      project: r.project,
      root: r.root,
      lastSeenAt: r.last_seen_at,
      ...(r.status_text !== null && r.status_at !== null && { status: { text: r.status_text, at: r.status_at } }),
      ...(r.title !== null && { title: r.title }),
      ...(r.closed_at !== null && { closedAt: r.closed_at }),
    });
  }

  private static toLink(r: LinkRow): MessageLink {
    return {
      chatId: r.chat_id,
      messageId: r.message_id,
      sessionKey: r.session_key,
      ...(r.question_id !== null && { questionId: r.question_id }),
      ...(r.inbox_id !== null && { inboxId: r.inbox_id }),
      ...(r.item !== null && { item: r.item }),
    };
  }

  /** Строка до v6 (`items` нет) — пачка из одного пункта по плоским полям. */
  private static toQuestion(r: QuestionRow): Question {
    const items: QuestionItem[] = r.items
      ? JSON.parse(r.items)
      : [
          {
            text: r.text,
            options: JSON.parse(r.options),
            ...(r.recommended !== null && { recommended: r.recommended }),
            ...(r.resolution !== null && { resolution: JSON.parse(r.resolution) }),
            lateAnswers: JSON.parse(r.late_answers),
          },
        ];
    return Question.restore({
      id: r.id,
      sessionKey: r.session_key,
      person: r.person,
      items,
      status: r.status,
      askedAt: r.asked_at,
      ...(r.deadline_at !== null && { deadlineAt: r.deadline_at }),
      ...(r.held_at !== null && { heldAt: r.held_at }),
      ...(r.terminal_at !== null && { terminalAt: r.terminal_at }),
    });
  }
}
