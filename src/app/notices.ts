import type { InboxItem } from '../domain/inbox.ts';
import type { Question } from '../domain/question.ts';
import type { Session } from '../domain/session.ts';
import { Messages } from './messages.ts';
import type { Store } from './store.ts';
import { TelegramError, type TelegramPort } from './telegram.ts';

/**
 * Служебные правки в Telegram после того, как сценарий уже сохранил своё: обновить сообщение вопроса,
 * поставить и сменить отметку входящего. Best effort — сбой Telegram не отменяет сохранённое.
 */
export class Notices {
  constructor(
    private readonly store: Store,
    private readonly telegram: TelegramPort,
  ) {}

  /** Перерисовать все сообщения вопроса по его состоянию; кнопки остаются для переигрывания. */
  async refreshQuestion(question: Question, session: Session): Promise<void> {
    const text = Messages.question(question, session);
    const buttons = Messages.questionButtons(question);
    for (const link of this.store.linksOfQuestion(question.id)) {
      await this.bestEffort(() => this.telegram.edit(link.chatId, link.messageId, text, buttons));
    }
  }

  /** Отметка «в ящике сессии X» — reply на сообщение человека, связанная с входящим. */
  async queued(item: InboxItem, session: Session, chatId: number, replyTo: number): Promise<void> {
    await this.bestEffort(async () => {
      const messageId = await this.telegram.send({ chatId, text: Messages.inboxQueued(session), replyTo });
      this.store.saveLink({ chatId, messageId, sessionKey: session.key, inboxId: item.id });
    });
  }

  /** Отметки входящего → «прочитано агентом». */
  async read(item: InboxItem, session: Session): Promise<void> {
    for (const link of this.store.linksOfInbox(item.id)) {
      await this.bestEffort(() => this.telegram.edit(link.chatId, link.messageId, Messages.inboxRead(session)));
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
