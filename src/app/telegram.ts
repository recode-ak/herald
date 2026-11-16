/** Inline-кнопка: подпись и `callback_data` (≤ 64 байт по правилам Bot API). */
export interface Button {
  text: string;
  data: string;
}

/** Ряды inline-кнопок. */
export type Keyboard = Button[][];

export interface OutgoingMessage {
  chatId: number;
  text: string;
  buttons?: Keyboard;
  /** message_id, на который отвечаем. */
  replyTo?: number;
}

/** Ошибка доставки в Telegram: сеть, отказ Bot API, бот заблокирован. */
export class TelegramError extends Error {
  override name = 'TelegramError';
}

/** Исходящая сторона Telegram для сценариев. Реализация — `infra/telegram.ts`; в тестах — `FakeTelegram`. */
export interface TelegramPort {
  /** Отправить сообщение; возвращает его message_id. */
  send(message: OutgoingMessage): Promise<number>;
  /** Заменить текст и кнопки сообщения. Без `buttons` кнопки убираются. */
  edit(chatId: number, messageId: number, text: string, buttons?: Keyboard): Promise<void>;
  /** Поставить реакцию на сообщение (заменяет прежнюю реакцию бота). `emoji` — из разрешённых Telegram. */
  react(chatId: number, messageId: number, emoji: string): Promise<void>;
  /** Ответить на нажатие кнопки (снять «часики»), опционально — всплывающий текст. */
  answerCallback(callbackId: string, text?: string): Promise<void>;
}

/** Входящий апдейт Telegram в форме, нужной сценариям. */
export type TelegramUpdate =
  | {
      kind: 'message';
      updateId: number;
      chatId: number;
      messageId: number;
      text: string;
      /** message_id сообщения, на которое человек ответил reply. */
      replyTo?: number;
    }
  | {
      kind: 'callback';
      updateId: number;
      callbackId: string;
      chatId: number;
      messageId: number;
      data: string;
    };
