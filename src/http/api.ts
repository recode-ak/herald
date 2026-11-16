import type { AgentService } from '../app/agent.ts';
import { type Caller, ForbiddenError, NotFoundError } from '../app/ports.ts';
import { TelegramError } from '../app/telegram.ts';
import type { Access } from '../domain/access.ts';
import { DomainError } from '../domain/errors.ts';
import { InboxItem } from '../domain/inbox.ts';
import type { Choice } from '../domain/question.ts';
import { BadRequestError, RequestBody } from './body.ts';
import { Wire } from './wire.ts';

export interface HttpApiDeps {
  agent: AgentService;
  access: Access;
  /** Потолок одного long poll: дольше клиент переподключается сам. */
  maxWaitMs: number;
  /** Куда писать непредвиденные ошибки. */
  log?: (message: string) => void;
}

/** Обработчик действия; `undefined` → `{ ok: true }`. */
type Handler = (caller: Caller, body: RequestBody) => Promise<unknown>;
type HttpServer = ReturnType<typeof Bun.serve>;

class UnauthorizedError extends Error {
  override name = 'UnauthorizedError';
}

/**
 * HTTP API агента: `POST /v1/<действие>`, JSON, `Authorization: Bearer <токен>`; `GET /health` — без токена.
 * Сессия вызывающего — поле `session` тела. Ожидание (`waitMs`) ограничено `maxWaitMs`.
 */
export class HttpApi {
  /** Предел idleTimeout `Bun.serve` — 255 с; оставляем запас поверх ожидания. */
  static readonly MAX_WAIT_LIMIT_MS = 240_000;
  private readonly routes: ReadonlyMap<string, Handler>;

  constructor(private readonly deps: HttpApiDeps) {
    if (!Number.isSafeInteger(deps.maxWaitMs) || deps.maxWaitMs <= 0 || deps.maxWaitMs > HttpApi.MAX_WAIT_LIMIT_MS) {
      throw new RangeError(`maxWaitMs — от 1 до ${HttpApi.MAX_WAIT_LIMIT_MS}`);
    }
    const { agent } = deps;
    this.routes = new Map<string, Handler>([
      ['/v1/notify', (c, b) => agent.notify(c, b.string('text'))],
      [
        '/v1/ask',
        async (c, b) => {
          const recommended = b.optionalString('recommended');
          const timeoutMs = b.optionalMs('timeoutMs');
          const input = {
            text: b.string('text'),
            options: b.options(),
            ...(recommended !== undefined && { recommended }),
            ...(timeoutMs !== undefined && { timeoutMs }),
          };
          return { question: Wire.question(await agent.ask(c, input)) };
        },
      ],
      [
        '/v1/question',
        async (c, b) => ({ question: Wire.question(await agent.awaitQuestion(c, b.string('id'), this.wait(b))) }),
      ],
      [
        '/v1/decide',
        async (c, b) => ({
          question: Wire.question(await agent.decide(c, b.string('id'), HttpApi.choice(b), b.string('reason'))),
        }),
      ],
      [
        '/v1/answered',
        async (c, b) => ({ question: Wire.question(await agent.answered(c, b.string('id'), HttpApi.choice(b))) }),
      ],
      ['/v1/status', (c, b) => agent.status(c, b.string('text'))],
      ['/v1/title', (c, b) => agent.title(c, b.string('text'))],
      ['/v1/bye', (c) => agent.bye(c)],
      [
        '/v1/inbox',
        async (c, b) => {
          const kinds = InboxItem.kinds(b.optionalStrings('kinds'));
          return { items: (await agent.awaitInbox(c, this.wait(b), kinds)).map(Wire.inboxItem) };
        },
      ],
      ['/v1/ack', async (c, b) => ({ read: await agent.ack(c, b.strings('ids')) })],
    ]);
  }

  /** Поднять сервер. `port: 0` — случайный свободный порт. */
  listen(options: { port: number; hostname: string }): HttpServer {
    const idleTimeout = Math.ceil(this.deps.maxWaitMs / 1000) + 15;
    return Bun.serve({ ...options, idleTimeout, fetch: (req) => this.fetch(req) });
  }

  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === '/health') return HttpApi.json(200, { ok: true });
    try {
      const person = this.authenticate(req);
      const handler = this.routes.get(pathname);
      if (!handler) return HttpApi.json(404, { error: `нет пути ${pathname}` });
      if (req.method !== 'POST') return HttpApi.json(405, { error: 'ожидается POST' });
      const body = await RequestBody.read(req);
      const result = await handler({ person, session: body.session() }, body);
      return HttpApi.json(200, result ?? { ok: true });
    } catch (error) {
      return this.failure(error);
    }
  }

  private authenticate(req: Request): string {
    const header = req.headers.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const person = token ? this.deps.access.personByToken(token) : undefined;
    if (!person) throw new UnauthorizedError('неверный или отсутствующий токен');
    return person;
  }

  private wait(body: RequestBody): number {
    return Math.min(body.waitMs(), this.deps.maxWaitMs);
  }

  private static choice(body: RequestBody): Choice {
    const option = body.optionalString('option');
    if (option !== undefined) return { option };
    const text = body.optionalString('text');
    if (text !== undefined) return { text };
    throw new BadRequestError('нужно поле «option» или «text»');
  }

  private failure(error: unknown): Response {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UnauthorizedError) return HttpApi.json(401, { error: message });
    if (error instanceof BadRequestError || error instanceof DomainError) return HttpApi.json(400, { error: message });
    if (error instanceof ForbiddenError) return HttpApi.json(403, { error: message });
    if (error instanceof NotFoundError) return HttpApi.json(404, { error: message });
    if (error instanceof TelegramError) return HttpApi.json(502, { error: message });
    (this.deps.log ?? console.error)(
      `herald: непредвиденная ошибка: ${error instanceof Error ? error.stack : message}`,
    );
    return HttpApi.json(500, { error: 'внутренняя ошибка сервера' });
  }

  private static json(status: number, body: unknown): Response {
    return Response.json(body, { status });
  }
}
