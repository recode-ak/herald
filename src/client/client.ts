import type { Clock } from '../app/ports.ts';
import type { InboxKind } from '../domain/inbox.ts';
import type { Choice, QuestionOption } from '../domain/question.ts';
import type { SessionRef } from '../domain/session.ts';
import type { InboxItemWire, QuestionWire } from '../http/wire.ts';

/** Ошибка обращения к серверу: `status` — HTTP-код ответа, без него — сервер недоступен. */
export class HeraldClientError extends Error {
  override name = 'HeraldClientError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface HeraldClientOptions {
  serverUrl: string;
  token: string;
  session: SessionRef;
  clock: Clock;
  /** Пауза перед повтором ожидания после сбоя сети или 5xx. */
  retryDelayMs?: number;
  /** Сколько просить ждать за один запрос; сервер урезает до своего потолка. */
  chunkMs?: number;
}

export interface AskRequest {
  text: string;
  options: QuestionOption[];
  recommended?: string;
  /** Сколько агент ждёт, прежде чем решить сам; без него решать будет нельзя. */
  timeoutMs?: number;
}

/**
 * HTTP-клиент herald — общий для CLI и канала. Long poll: ожидание переподключается до своего таймаута,
 * сбои сети и 5xx во время ожидания пережидаются; обычные вызовы падают сразу.
 */
export class HeraldClient {
  private readonly retryDelayMs: number;
  private readonly chunkMs: number;

  constructor(private readonly options: HeraldClientOptions) {
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
    this.chunkMs = options.chunkMs ?? 50_000;
  }

  async notify(text: string): Promise<void> {
    await this.call('/v1/notify', { text });
  }

  async status(text: string): Promise<void> {
    await this.call('/v1/status', { text });
  }

  /** Окно агента закрывается. */
  async bye(): Promise<void> {
    await this.call('/v1/bye', {});
  }

  async title(text: string): Promise<void> {
    await this.call('/v1/title', { text });
  }

  async ask(request: AskRequest): Promise<QuestionWire> {
    return ((await this.call('/v1/ask', { ...request })) as { question: QuestionWire }).question;
  }

  /** Человек ответил в терминале агента: закрыть вопрос его ответом. */
  async answered(id: string, choice: Choice): Promise<QuestionWire> {
    return ((await this.call('/v1/answered', { id, ...choice })) as { question: QuestionWire }).question;
  }

  async decide(id: string, choice: Choice, reason: string): Promise<QuestionWire> {
    return ((await this.call('/v1/decide', { id, ...choice, reason })) as { question: QuestionWire }).question;
  }

  async ack(ids: readonly string[]): Promise<string[]> {
    return ((await this.call('/v1/ack', { ids })) as { read: string[] }).read;
  }

  /** Ждать ответа до `timeoutMs` (без него — бесконечно). По таймауту — вопрос в `open`. */
  async awaitQuestion(id: string, timeoutMs?: number): Promise<QuestionWire> {
    return this.poll(
      timeoutMs,
      async (waitMs) => ((await this.call('/v1/question', { id, waitMs })) as { question: QuestionWire }).question,
      (q) => q.status !== 'open',
    );
  }

  /** Непрочитанные входящие (`kinds` — только этих видов); если их нет — ждать первых до `waitMs` (0 — не ждать). */
  async inbox(waitMs = 0, kinds: readonly InboxKind[] = []): Promise<InboxItemWire[]> {
    const filter = kinds.length > 0 ? { kinds } : {};
    return this.poll(
      waitMs,
      async (chunk) =>
        ((await this.call('/v1/inbox', { waitMs: chunk, ...filter })) as { items: InboxItemWire[] }).items,
      (items) => items.length > 0,
    );
  }

  /** Повторять ожидающий запрос кусками до результата или таймаута (`undefined` — бесконечно). */
  private async poll<T>(
    timeoutMs: number | undefined,
    fetchChunk: (waitMs: number) => Promise<T>,
    done: (r: T) => boolean,
  ): Promise<T> {
    const { clock } = this.options;
    const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : clock.now() + timeoutMs;
    for (;;) {
      const left = deadline - clock.now();
      try {
        const result = await fetchChunk(Math.max(0, Math.min(this.chunkMs, left)));
        if (done(result) || clock.now() >= deadline) return result;
      } catch (error) {
        const transient = error instanceof HeraldClientError && (error.status === undefined || error.status >= 500);
        if (!transient || clock.now() + this.retryDelayMs >= deadline) throw error;
        await clock.sleep(this.retryDelayMs, new AbortController().signal);
      }
    }
  }

  private async call(path: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.options.serverUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session: this.options.session, ...body }),
      });
    } catch (error) {
      throw new HeraldClientError(`сервер herald недоступен (${this.options.serverUrl}): ${(error as Error).message}`);
    }
    const data = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    if (!response.ok) {
      throw new HeraldClientError(data?.error ?? `HTTP ${response.status} ${response.statusText}`, response.status);
    }
    return data;
  }
}
