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

/** Пункт пачки в запросе. */
export interface AskItem {
  text: string;
  options: QuestionOption[];
  recommended?: string;
}

/** Ответ на пункт пачки в запросе (нумерация с 1). */
export type ItemAnswerRequest = { item: number } & ({ option: string } | { text: string });

/** Одиночный вопрос (поля пункта) или пачка (`questions`); `timeoutMs` — на весь вопрос. */
export type AskRequest = (AskItem | { questions: AskItem[] }) & {
  /** Сколько агент ждёт, прежде чем решить сам; без него решать будет нельзя. */
  timeoutMs?: number;
};

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
    return HeraldClient.question(await this.call('/v1/ask', { ...request }));
  }

  /** Человек ответил в терминале агента: закрыть вопрос (или пункты пачки) его ответами. */
  async answered(id: string, answers: Choice | readonly ItemAnswerRequest[]): Promise<QuestionWire> {
    return HeraldClient.question(await this.call('/v1/answered', { id, ...HeraldClient.answers(answers) }));
  }

  /** Решение агента: ответ (одиночный вопрос) или ответы по пунктам; пункты без ответа — рекомендованные. */
  async decide(id: string, answers: Choice | readonly ItemAnswerRequest[], reason: string): Promise<QuestionWire> {
    return HeraldClient.question(await this.call('/v1/decide', { id, ...HeraldClient.answers(answers), reason }));
  }

  /** Человек ответит в терминале: вопрос `id` или все открытые вопросы сессии. */
  async toTerminal(id?: string): Promise<QuestionWire[]> {
    const { questions } = (await this.call('/v1/to-terminal', id !== undefined ? { id } : {})) as {
      questions: QuestionWire[];
    };
    return questions.map(HeraldClient.withItems);
  }

  async ack(ids: readonly string[]): Promise<string[]> {
    return ((await this.call('/v1/ack', { ids })) as { read: string[] }).read;
  }

  /** Ждать ответа или перевода в терминал до `timeoutMs` (без него — бесконечно). По таймауту — вопрос в `open`. */
  async awaitQuestion(id: string, timeoutMs?: number): Promise<QuestionWire> {
    return this.poll(
      timeoutMs,
      async (waitMs) => HeraldClient.question(await this.call('/v1/question', { id, waitMs })),
      (q) => q.status !== 'open' || q.terminalAt !== undefined,
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

  private static question(body: unknown): QuestionWire {
    return HeraldClient.withItems((body as { question: QuestionWire }).question);
  }

  /** Сервер до пачек (v6) не присылает `items` — одиночный вопрос из плоских полей. */
  private static withItems(q: QuestionWire): QuestionWire {
    if (Array.isArray(q.items)) return q;
    const { text, options, recommended, resolution, lateAnswers } = q;
    return {
      ...q,
      items: [
        {
          text,
          options,
          ...(recommended !== undefined && { recommended }),
          ...(resolution && { resolution }),
          lateAnswers,
        },
      ],
    };
  }

  private static answers(answers: Choice | readonly ItemAnswerRequest[]): Record<string, unknown> {
    return Array.isArray(answers) ? { answers } : { ...(answers as Choice) };
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
