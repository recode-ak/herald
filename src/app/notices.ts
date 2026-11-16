import type { InboxItem } from '../domain/inbox.ts';
import type { Question } from '../domain/question.ts';
import type { Session } from '../domain/session.ts';
import { Messages } from './messages.ts';
import type { Store } from './store.ts';
import { TelegramError, type TelegramPort } from './telegram.ts';

/**
 * Служебные правки в Telegram после того, как сценарий уже сохранил своё: обновить сообщение вопроса,
 * поставить и сменить реакцию на сообщении человека. Best effort — сбой Telegram не отменяет сохранённое.
 */
export class Notices {
  constructor(
    private readonly store: Store,
    private readonly telegram: TelegramPort,
  ) {}

  /** Перерисовать все сообщения вопроса по его состоянию; кнопки остаются для переигрывания. */
  async refreshQuestion(question: Question, session: Session): Promise<void> {
    const text = Messages.question(question, session);
    const html = Messages.questionHtml(question, session);
    const buttons = Messages.questionButtons(question);
    for (const link of this.store.linksOfQuestion(question.id)) {
      await this.bestEffort(() => this.telegram.edit(link.chatId, link.messageId, text, buttons, html));
    }
  }

  /**
   * Реакция «в ящике» на сообщение человека, из которого родилось входящее. Связь сообщения с входящим —
   * для реакции «прочитано»; reply на это сообщение — указание той же сессии.
   */
  async queued(item: InboxItem, session: Session, chatId: number, messageId: number): Promise<void> {
    this.store.saveLink({ chatId, messageId, sessionKey: session.key, inboxId: item.id });
    await this.bestEffort(() => this.telegram.react(chatId, messageId, Messages.INBOX_QUEUED));
  }

  /** Предупреждение reply на сообщение человека: сессия не на связи, прочтёт позже. */
  async warn(warning: string, chatId: number, replyTo: number): Promise<void> {
    await this.bestEffort(async () => {
      await this.telegram.send({ chatId, text: Messages.offlineNotice(warning), replyTo });
    });
  }

  /** Реакция на сообщениях входящего → «прочитано». */
  async read(item: InboxItem): Promise<void> {
    for (const link of this.store.linksOfInbox(item.id)) {
      await this.bestEffort(() => this.telegram.react(link.chatId, link.messageId, Messages.INBOX_READ));
    }
  }

  private async bestEffort(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (!(error instanceof TelegramError)) throw error;
    }
  }
}
