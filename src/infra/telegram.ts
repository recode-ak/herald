import type { Clock } from '../app/ports.ts';
import {
  type Keyboard,
  type OutgoingMessage,
  TelegramError,
  type TelegramPort,
  type TelegramUpdate,
} from '../app/telegram.ts';

export interface TelegramBotApiOptions {
  token: string;
  /** Без хвостового `/`; по умолчанию — `https://api.telegram.org`. */
  baseUrl?: string;
  clock: Clock;
  /** Повторов после первой попытки (сеть, 5xx, 429). */
  retries?: number;
  /** Пауза перед n-м повтором — `retryDelayMs · 2ⁿ`. */
  retryDelayMs?: number;
}

/** Пачка апдейтов и offset следующего запроса (учитывает и пропущенные апдейты). */
export interface UpdateBatch {
  updates: TelegramUpdate[];
  nextOffset: number;
}

interface BotApiReply {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

interface RawMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  reply_to_message?: { message_id: number };
}

interface RawUpdate {
  update_id: number;
  message?: RawMessage;
  callback_query?: { id: string; data?: string; message?: RawMessage };
}

/** Telegram Bot API через `fetch`: исходящие сообщения (порт сценариев) и long polling `getUpdates`. */
export class TelegramBotApi implements TelegramPort {
  /** Дольше `retry_after` не ждём: агент ждёт ответа HTTP. */
  static readonly MAX_RETRY_AFTER_MS = 30_000;
  private readonly baseUrl: string;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: TelegramBotApiOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.telegram.org';
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  async send(message: OutgoingMessage): Promise<number> {
    const result = (await this.call('sendMessage', {
      chat_id: message.chatId,
      text: message.text,
      ...(message.buttons && { reply_markup: TelegramBotApi.markup(message.buttons) }),
      ...(message.replyTo !== undefined && {
        reply_parameters: { message_id: message.replyTo, allow_sending_without_reply: true },
      }),
    })) as RawMessage;
    return result.message_id;
  }

  async edit(chatId: number, messageId: number, text: string, buttons?: Keyboard): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: TelegramBotApi.markup(buttons ?? []),
      });
    } catch (error) {
      if (error instanceof TelegramError && error.message.includes('message is not modified')) return;
      throw error;
    }
  }

  async react(chatId: number, messageId: number, emoji: string): Promise<void> {
    await this.call('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    });
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text !== undefined && { text }) });
  }

  /** Long poll: ждать апдейты до `timeoutSec`. Отмена `signal` обрывает запрос без повторов. */
  async getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<UpdateBatch> {
    const raw = (await this.call(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
      signal,
    )) as RawUpdate[];
    const updates = raw.flatMap((u) => TelegramBotApi.update(u) ?? []);
    const last = raw.at(-1);
    return { updates, nextOffset: last ? last.update_id + 1 : offset };
  }

  private async call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.baseUrl}/bot${this.options.token}/${method}`;
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.retries;
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          ...(signal && { signal }),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (canRetry) {
          await this.pause(this.retryDelayMs * 2 ** attempt, signal);
          continue;
        }
        throw new TelegramError(`Telegram ${method}: сеть — ${this.redact(error)}`);
      }

      const reply = (await response.json().catch(() => undefined)) as BotApiReply | undefined;
      if (reply?.ok) return reply.result;
      const code = reply?.error_code ?? response.status;
      const description = reply?.description ?? response.statusText;
      const retryAfterMs = (reply?.parameters?.retry_after ?? 1) * 1000;
      if (canRetry && code === 429 && retryAfterMs <= TelegramBotApi.MAX_RETRY_AFTER_MS) {
        await this.pause(retryAfterMs, signal);
        continue;
      }
      if (canRetry && code >= 500) {
        await this.pause(this.retryDelayMs * 2 ** attempt, signal);
        continue;
      }
      throw new TelegramError(`Telegram ${method}: ${code} ${description}`);
    }
  }

  private pause(ms: number, signal?: AbortSignal): Promise<void> {
    return this.options.clock.sleep(ms, signal ?? new AbortController().signal);
  }

  /** Текст ошибки без токена бота (он — в URL). */
  private redact(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replaceAll(this.options.token, '***');
  }

  private static markup(buttons: Keyboard): { inline_keyboard: { text: string; callback_data: string }[][] } {
    return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
  }

  /** Апдейт в форме сценариев; не текст и не кнопка — `undefined`. */
  private static update(u: RawUpdate): TelegramUpdate | undefined {
    if (u.message?.text !== undefined) {
      const m = u.message;
      return {
        kind: 'message',
        updateId: u.update_id,
        chatId: m.chat.id,
        messageId: m.message_id,
        text: m.text as string,
        ...(m.reply_to_message && { replyTo: m.reply_to_message.message_id }),
      };
    }
    const cb = u.callback_query;
    if (cb?.data !== undefined && cb.message) {
      return {
        kind: 'callback',
        updateId: u.update_id,
        callbackId: cb.id,
        chatId: cb.message.chat.id,
        messageId: cb.message.message_id,
        data: cb.data,
      };
    }
    return undefined;
  }
}
