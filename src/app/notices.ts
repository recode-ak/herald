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
    private readonly timeZone: string,
  ) {}

  /** Отправить сообщение пункта `n` и связать его с вопросом (у пачки — и с пунктом). Сбой Telegram — ошибка. */
  async sendItem(question: Question, session: Session, chatId: number, n: number): Promise<number> {
    const messageId = await this.telegram.send({
      chatId,
      text: Messages.question(question, session, this.timeZone, n),
      html: Messages.questionHtml(question, session, this.timeZone, n),
      buttons: Messages.questionButtons(question, n),
    });
    this.store.saveLink({
      chatId,
      messageId,
      sessionKey: session.key,
      questionId: question.id,
      ...(question.isBatch && { item: n }),
    });
    return messageId;
  }

  /** Последний отправленный пункт вопроса (0 — ни одного). */
  sent(question: Question): number {
    return Math.max(0, ...this.store.linksOfQuestion(question.id).map((l) => l.item ?? 1));
  }

  /**
   * Очередь пачки: вопрос открыт, не переведён в терминал, а текущий пункт ещё не отправлен — отправить его.
   * Возвращает номер отправленного пункта.
   */
  async advance(question: Question, session: Session, chatId: number): Promise<number | undefined> {
    const next = question.current;
    if (question.status !== 'open' || question.terminalAt !== undefined || next === undefined) return undefined;
    if (next <= this.sent(question)) return undefined;
    await this.bestEffort(async () => void (await this.sendItem(question, session, chatId, next)));
    return next;
  }

  /** Перерисовать все сообщения вопроса по его состоянию (каждое — свой пункт); кнопки остаются для переигрывания. */
  async refreshQuestion(question: Question, session: Session): Promise<void> {
    const links = this.store.linksOfQuestion(question.id);
    const sent = Math.max(0, ...links.map((l) => l.item ?? 1));
    for (const link of links) {
      const n = link.item ?? 1;
      const text = Messages.question(question, session, this.timeZone, n, { sent });
      const html = Messages.questionHtml(question, session, this.timeZone, n, { sent });
      const buttons = Messages.questionButtons(question, n);
      await this.bestEffort(() => this.telegram.edit(link.chatId, link.messageId, text, buttons, html));
    }
  }

  /** После решения агента: пункты, которых человек не видел, — одним итоговым сообщением (reply — указание). */
  async decidedRest(question: Question, session: Session, chatId: number): Promise<void> {
    const sent = this.sent(question);
    if (!Messages.hasDecidedRest(question, sent)) return;
    await this.bestEffort(async () => {
      const messageId = await this.telegram.send({
        chatId,
        text: Messages.decidedRest(question, session, sent),
        html: Messages.decidedRestHtml(question, session, sent),
      });
      this.store.saveLink({ chatId, messageId, sessionKey: session.key });
    });
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

  /** Закрыть меню: итог вместо текста, кнопки убраны. */
  async closeMenu(chatId: number, messageId: number, text: string): Promise<void> {
    await this.bestEffort(() => this.telegram.edit(chatId, messageId, text));
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
