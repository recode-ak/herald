/** Вызов метода Bot API, полученный фейком. */
export interface BotApiCall {
  method: string;
  params: Record<string, unknown>;
}

interface ScriptedFailure {
  status: number;
  body: unknown;
}

/**
 * Локальный фейк Telegram Bot API для тестов адаптера и сервера: `http://127.0.0.1:<port>/bot<токен>/<метод>`.
 * Хранит вызовы, выдаёт апдейты по offset (long poll до `timeout` или нового апдейта), умеет сбоить по сценарию.
 */
export class FakeBotApi {
  readonly calls: BotApiCall[] = [];
  private readonly updates: { update_id: number; [key: string]: unknown }[] = [];
  private readonly failures = new Map<string, ScriptedFailure[]>();
  private readonly pollers = new Set<() => void>();
  private nextMessageId = 1;
  private nextUpdateId = 1;
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(readonly token = 'bot-token') {
    this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => this.handle(req) });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    for (const wake of this.pollers) wake();
    this.server.stop(true);
  }

  /** Добавить апдейт (без `update_id` — назначается). Будит ждущий `getUpdates`. */
  pushUpdate(update: Record<string, unknown>): number {
    const updateId = this.nextUpdateId++;
    this.updates.push({ ...update, update_id: updateId });
    for (const wake of this.pollers) wake();
    return updateId;
  }

  /** Следующие вызовы `method` ответят сбоем: `{ status, body }` по одному на вызов. */
  failNext(method: string, ...failures: ScriptedFailure[]): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...failures]);
  }

  callsOf(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  private async handle(req: Request): Promise<Response> {
    const match = new URL(req.url).pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!match || match[1] !== this.token) {
      return Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 });
    }
    const method = match[2] as string;
    const params = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    this.calls.push({ method, params });

    const failure = this.failures.get(method)?.shift();
    if (failure) return Response.json(failure.body, { status: failure.status });

    switch (method) {
      case 'getUpdates':
        return FakeBotApi.ok(await this.getUpdates(params, req.signal));
      case 'sendMessage':
        return FakeBotApi.ok({ message_id: this.nextMessageId++, chat: { id: params.chat_id }, text: params.text });
      case 'editMessageText':
      case 'answerCallbackQuery':
        return FakeBotApi.ok(true);
      default:
        return Response.json({ ok: false, error_code: 404, description: 'Not Found' }, { status: 404 });
    }
  }

  private async getUpdates(params: Record<string, unknown>, signal: AbortSignal): Promise<unknown[]> {
    const offset = typeof params.offset === 'number' ? params.offset : 0;
    const timeoutMs = (typeof params.timeout === 'number' ? params.timeout : 0) * 1000;
    // Как Telegram: offset подтверждает (удаляет) предыдущие апдейты.
    while (this.updates[0] && this.updates[0].update_id < offset) this.updates.shift();
    if (this.updates.length === 0 && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.pollers.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, timeoutMs);
        this.pollers.add(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
    return this.updates.filter((u) => u.update_id >= offset);
  }

  private static ok(result: unknown): Response {
    return Response.json({ ok: true, result });
  }
}
