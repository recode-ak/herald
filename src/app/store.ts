import type { PersonId } from '../domain/access.ts';
import type { Inbox, InboxItem } from '../domain/inbox.ts';
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
  inboxId?: string;
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

  saveInboxItem(item: InboxItem): void;
  /** Ящик сессии: непрочитанные и, сверх них, элементы `include` (чтобы подтвердить уже прочитанные). */
  inbox(sessionKey: string, include?: readonly string[]): Inbox;

  saveLink(link: MessageLink): void;
  link(chatId: number, messageId: number): MessageLink | undefined;
  linksOfQuestion(questionId: string): MessageLink[];
  linksOfInbox(inboxId: string): MessageLink[];

  /** offset `getUpdates`: следующий ожидаемый update_id. */
  telegramOffset(): number;
  setTelegramOffset(offset: number): void;
}
