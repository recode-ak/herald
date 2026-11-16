import { type Keyboard, type OutgoingMessage, TelegramError, type TelegramPort } from './telegram.ts';

export interface FakeMessage extends OutgoingMessage {
  messageId: number;
}

/** Telegram в памяти для тестов: хранит сообщения по чатам, правки и ответы на callback. */
export class FakeTelegram implements TelegramPort {
  readonly edits: { chatId: number; messageId: number; text: string; buttons?: Keyboard }[] = [];
  readonly callbackAnswers: { callbackId: string; text?: string }[] = [];
  private readonly messages = new Map<string, FakeMessage>();
  private nextId = 1;
  private failure: string | undefined;

  /** Следующая операция упадёт с `TelegramError`. */
  failNext(reason = 'Telegram недоступен'): void {
    this.failure = reason;
  }

  async send(message: OutgoingMessage): Promise<number> {
    this.maybeFail();
    const messageId = this.nextId++;
    this.messages.set(FakeTelegram.key(message.chatId, messageId), { ...message, messageId });
    return messageId;
  }

  async edit(chatId: number, messageId: number, text: string, buttons?: Keyboard): Promise<void> {
    this.maybeFail();
    const message = this.messages.get(FakeTelegram.key(chatId, messageId));
    if (!message) throw new TelegramError(`сообщения ${chatId}/${messageId} нет`);
    message.text = text;
    if (buttons) message.buttons = buttons;
    else delete message.buttons;
    this.edits.push({ chatId, messageId, text, ...(buttons && { buttons }) });
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    this.maybeFail();
    this.callbackAnswers.push({ callbackId, ...(text !== undefined && { text }) });
  }

  /** Копия сообщения: правки после чтения её не меняют. */
  message(chatId: number, messageId: number): FakeMessage | undefined {
    const message = this.messages.get(FakeTelegram.key(chatId, messageId));
    return message && structuredClone(message);
  }

  /** Сообщения чата в порядке отправки. */
  sentTo(chatId: number): FakeMessage[] {
    return [...this.messages.values()]
      .filter((m) => m.chatId === chatId)
      .sort((a, b) => a.messageId - b.messageId)
      .map((m) => structuredClone(m));
  }

  last(chatId: number): FakeMessage | undefined {
    return this.sentTo(chatId).at(-1);
  }

  private maybeFail(): void {
    if (this.failure === undefined) return;
    const reason = this.failure;
    this.failure = undefined;
    throw new TelegramError(reason);
  }

  private static key(chatId: number, messageId: number): string {
    return `${chatId}/${messageId}`;
  }
}
