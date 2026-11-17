import type { PersonId } from '../domain/access.ts';
import type { Host, Launch } from '../domain/host.ts';
import type { Inbox, InboxItem } from '../domain/inbox.ts';
import type { NewWindowDialog } from '../domain/new-window.ts';
import type { Question } from '../domain/question.ts';
import type { Session } from '../domain/session.ts';

/**
 * Сообщение в Telegram, связанное с сессией: по нему reply человека находит адресата.
 * `questionId` — сообщение вопроса; `inboxId` — сообщение человека, ставшее входящим (на него — отметки).
 */
export interface MessageLink {
  chatId: number;
  messageId: number;
  sessionKey: string;
  questionId?: string;
  /** Пункт пачки, которому принадлежит сообщение вопроса (нет — первый). */
  item?: number;
  inboxId?: string;
}

/**
 * Сколько записей по видам: сессии, вопросы, входящие, связи с сообщениями, выбранные адресаты чатов,
 * машины, запуски окон, диалоги `/new`.
 */
export interface PurgeCounts {
  sessions: number;
  questions: number;
  inbox: number;
  links: number;
  targets: number;
  hosts: number;
  launches: number;
  dialogs: number;
}

/** Итог очистки: удалено (при `dryRun` — было бы удалено), осталось, размер базы в байтах. */
export interface PurgeReport {
  deleted: PurgeCounts;
  remaining: PurgeCounts;
  dbBytes: number;
}

/** Порт хранилища для сценариев. Реализация — `infra/sqlite-store.ts`. Сохранение — upsert по id. */
export interface Store {
  transaction<T>(fn: () => T): T;

  session(key: string): Session | undefined;
  saveSession(session: Session): void;
  /** Сессии человека, недавние первыми. */
  sessionsOf(person: PersonId): Session[];

  question(id: string): Question | undefined;
  saveQuestion(question: Question): void;
  /** Открытые вопросы сессии — по времени. */
  openQuestions(sessionKey: string): Question[];

  saveInboxItem(item: InboxItem): void;
  /** Ящик сессии: непрочитанные и, сверх них, элементы `include` (чтобы подтвердить уже прочитанные). */
  inbox(sessionKey: string, include?: readonly string[]): Inbox;

  saveLink(link: MessageLink): void;
  link(chatId: number, messageId: number): MessageLink | undefined;
  linksOfQuestion(questionId: string): MessageLink[];
  linksOfInbox(inboxId: string): MessageLink[];

  /** Сессия, выбранная в `/sessions`: следующий текст чата — её указание. */
  chatTarget(chatId: number): string | undefined;
  setChatTarget(chatId: number, sessionKey: string | undefined): void;

  host(person: PersonId, name: string): Host | undefined;
  saveHost(host: Host): void;
  /** Машины человека, недавние первыми. */
  hostsOf(person: PersonId): Host[];

  launch(id: string): Launch | undefined;
  saveLaunch(launch: Launch): void;
  /** Невыданные запуски машины — по времени создания. */
  pendingLaunches(person: PersonId, host: string): Launch[];

  /** Диалог `/new` чата (один на чат). */
  dialog(chatId: number): NewWindowDialog | undefined;
  saveDialog(dialog: NewWindowDialog): void;
  deleteDialog(chatId: number): void;

  /**
   * Удалить записи старше границы `cutoff` (мс эпохи) по правилам `docs/model.md`, «Хранение»; одной транзакцией.
   * `dryRun` — только посчитать.
   */
  purge(cutoff: number, options?: { dryRun?: boolean }): PurgeReport;

  /** offset `getUpdates`: следующий ожидаемый update_id. */
  telegramOffset(): number;
  setTelegramOffset(offset: number): void;
}
