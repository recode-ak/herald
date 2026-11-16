import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AskRequest } from '../client/client.ts';
import type { Choice, QuestionOption } from '../domain/question.ts';
import type { InboxItemWire, QuestionWire } from '../http/wire.ts';

/** Что каналу нужно от клиента herald (реализация — `HeraldClient`, в тестах — `FakeHerald`). */
export interface ChannelHerald {
  notify(text: string): Promise<void>;
  status(text: string): Promise<void>;
  ask(request: AskRequest): Promise<QuestionWire>;
  decide(id: string, choice: Choice, reason: string): Promise<QuestionWire>;
  inbox(waitMs?: number): Promise<InboxItemWire[]>;
  ack(ids: readonly string[]): Promise<string[]>;
}

export interface HeraldChannelOptions {
  herald: ChannelHerald;
  log?: (message: string) => void;
  /** Long poll входящих за один запрос клиента. */
  inboxWaitMs?: number;
  /** Пауза после сбоя цикла входящих. */
  retryDelayMs?: number;
  /**
   * Подтверждение действий Claude Code из Telegram (`claude/channel/permission`). Выключено по умолчанию.
   * Отвечать может только человек токена: herald принимает ответы лишь с его chat_id.
   */
  permissionRelay?: boolean;
}

/** Запрос Claude Code на подтверждение действия. */
interface PermissionRequest {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

/** Неверные аргументы инструмента. */
class ToolArgsError extends Error {
  override name = 'ToolArgsError';
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const INSTRUCTIONS = [
  'herald — связь с человеком через Telegram. Человек читает Telegram, а не эту сессию: всё, что он должен увидеть, отправляй инструментом reply (или notify). Вывод в транскрипт до него не доходит.',
  '',
  'Сообщения человека приходят как <channel source="herald" kind="..." item_id="...">:',
  '- kind="directive" — указание человека этой сессии; выполни его как просьбу пользователя.',
  '- kind="answer" question_id="..." — ответ на твой вопрос (option — id выбранного варианта).',
  '- kind="late-answer" question_id="..." — переигрывание: ответ пришёл после твоего решения по таймауту; реши, нужно ли переделать.',
  '',
  'ask задаёт вопрос с вариантами и сразу возвращает id — не жди, продолжай работу; ответ придёт событием. Если ответа долго нет, прими рекомендованный вариант инструментом decide с причиной («по таймауту»). status — короткий статус сессии на границах задач (в Telegram не отправляется, человек видит его по /status).',
].join('\n');

const TOOLS = [
  {
    name: 'reply',
    description:
      'Отправить сообщение человеку в Telegram: ответ на указание, итог, промежуточный результат. Для вопроса — ask.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'notify',
    description: 'То же, что reply: уведомление человеку в Telegram.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'ask',
    description:
      'Задать человеку вопрос с кнопками вариантов. Сразу возвращает id; ответ придёт событием <channel kind="answer" question_id="...">.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string', description: 'короткий: A, B…' }, text: { type: 'string' } },
            required: ['id', 'text'],
          },
        },
        recommended: { type: 'string', description: 'id рекомендованного варианта' },
      },
      required: ['text'],
    },
  },
  {
    name: 'decide',
    description:
      'Принять решение по вопросу без ответа человека (например, по таймауту). Сообщение в Telegram обновится.',
    inputSchema: {
      type: 'object',
      properties: {
        question_id: { type: 'string' },
        option: { type: 'string', description: 'id варианта' },
        text: { type: 'string', description: 'свободный ответ вместо варианта' },
        reason: { type: 'string', description: 'почему, например «по таймауту»' },
      },
      required: ['question_id', 'reason'],
    },
  },
  {
    name: 'status',
    description: 'Обновить статус сессии (что делаю сейчас). В Telegram не отправляется; человек видит его по /status.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

/**
 * Канал herald для Claude Code: MCP-сервер с capability `claude/channel`, инструменты поверх клиента herald
 * и цикл входящих → `notifications/claude/channel` → подтверждение прочтения.
 */
export class HeraldChannel {
  // Низкоуровневый Server (deprecated в SDK в пользу McpServer, которому нужны zod-схемы) — как в официальных каналах.
  private readonly server: Server;
  private readonly herald: ChannelHerald;
  private readonly log: (message: string) => void;
  private running = false;
  private loop: Promise<void> | undefined;
  /** Вопросы-подтверждения: id вопроса → request_id; решённые остаются с `undefined` (поздние ответы — не события). */
  private readonly permissions = new Map<string, string | undefined>();
  static readonly PREVIEW_MAX = 1_000;

  constructor(private readonly options: HeraldChannelOptions) {
    this.herald = options.herald;
    this.log = options.log ?? ((m) => process.stderr.write(`${m}\n`));
    this.server = new Server(
      { name: 'herald', version: '0.1.0' },
      {
        capabilities: {
          tools: {},
          experimental: {
            'claude/channel': {},
            ...(options.permissionRelay && { 'claude/channel/permission': {} }),
          },
        },
        instructions: INSTRUCTIONS,
      },
    );
    if (options.permissionRelay) {
      // Схемы zod у этого уведомления нет — ловим его в fallback.
      this.server.fallbackNotificationHandler = async (n) => {
        if (n.method === 'notifications/claude/channel/permission_request') {
          await this.askPermission(n.params as unknown as PermissionRequest);
        }
      };
    }
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    this.server.setRequestHandler(CallToolRequestSchema, async (req) =>
      this.callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
    );
  }

  /** Вызывается, когда клиент (Claude Code) закрыл соединение. */
  set onclose(handler: () => void) {
    this.server.onclose = handler;
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /** Запустить цикл входящих. */
  start(): void {
    if (this.loop) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Остановить цикл и закрыть MCP. Висящий long poll не ждём: его результат будет отброшен. */
  async close(): Promise<void> {
    this.running = false;
    await this.server.close();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const items = await this.herald.inbox(this.options.inboxWaitMs ?? 50_000);
        if (!this.running) return;
        for (const item of items) {
          if (item.questionId !== undefined && this.permissions.has(item.questionId)) await this.permit(item);
          else await this.deliver(item);
        }
        if (items.length > 0) await this.herald.ack(items.map((i) => i.id));
      } catch (error) {
        this.log(`herald channel: входящие: ${HeraldChannel.message(error)}`);
        await Bun.sleep(this.options.retryDelayMs ?? 5_000);
      }
    }
  }

  /** Запрос подтверждения → вопрос человеку. Сбой — в лог: Claude Code всё равно спросит в терминале. */
  private async askPermission(request: PermissionRequest): Promise<void> {
    const preview = request.input_preview.slice(0, HeraldChannel.PREVIEW_MAX);
    try {
      const question = await this.herald.ask({
        text: `🔐 Разрешить ${request.tool_name}?\n${request.description}\n\n${preview}`,
        options: [
          { id: 'allow', text: 'Разрешить' },
          { id: 'deny', text: 'Запретить' },
        ],
      });
      this.permissions.set(question.id, request.request_id);
    } catch (error) {
      this.log(`herald channel: подтверждение ${request.request_id}: ${HeraldChannel.message(error)}`);
    }
  }

  /** Ответ на вопрос-подтверждение: «Разрешить» — allow, всё прочее — deny; поздний ответ отбрасывается. */
  private async permit(item: InboxItemWire): Promise<void> {
    const requestId = this.permissions.get(item.questionId as string);
    if (item.kind !== 'answer' || requestId === undefined) return;
    this.permissions.set(item.questionId as string, undefined);
    await this.server.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: requestId, behavior: item.option === 'allow' ? 'allow' : 'deny' },
    });
  }

  private async deliver(item: InboxItemWire): Promise<void> {
    const content =
      item.kind === 'answer'
        ? `Ответ на вопрос ${item.questionId}: ${item.text}`
        : item.kind === 'late-answer'
          ? `Переигрывание вопроса ${item.questionId}: ${item.text}`
          : item.text;
    const meta: Record<string, string> = {
      kind: item.kind,
      item_id: item.id,
      ...(item.questionId !== undefined && { question_id: item.questionId }),
      ...(item.option !== undefined && { option: item.option }),
    };
    await this.server.notification({ method: 'notifications/claude/channel', params: { content, meta } });
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'reply':
        case 'notify':
          await this.herald.notify(HeraldChannel.string(args, 'text'));
          return HeraldChannel.ok('отправлено');
        case 'status':
          await this.herald.status(HeraldChannel.string(args, 'text'));
          return HeraldChannel.ok('статус обновлён');
        case 'ask': {
          const recommended = HeraldChannel.optionalString(args, 'recommended');
          const question = await this.herald.ask({
            text: HeraldChannel.string(args, 'text'),
            options: HeraldChannel.options(args),
            ...(recommended !== undefined && { recommended }),
          });
          return HeraldChannel.ok(
            `вопрос ${question.id} задан; ответ придёт событием <channel kind="answer" question_id="${question.id}">`,
          );
        }
        case 'decide': {
          const option = HeraldChannel.optionalString(args, 'option');
          const text = HeraldChannel.optionalString(args, 'text');
          if ((option === undefined) === (text === undefined)) throw new ToolArgsError('нужен option или text');
          const choice: Choice = option !== undefined ? { option } : { text: text as string };
          const question = await this.herald.decide(
            HeraldChannel.string(args, 'question_id'),
            choice,
            HeraldChannel.string(args, 'reason'),
          );
          return HeraldChannel.ok(`решение по вопросу ${question.id} принято`);
        }
        default:
          throw new ToolArgsError(`нет инструмента ${name}`);
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `${name}: ${HeraldChannel.message(error)}` }], isError: true };
    }
  }

  private static ok(text: string): ToolResult {
    return { content: [{ type: 'text', text }] };
  }

  private static string(args: Record<string, unknown>, name: string): string {
    const value = args[name];
    if (typeof value !== 'string') throw new ToolArgsError(`аргумент «${name}» — ожидается строка`);
    return value;
  }

  private static optionalString(args: Record<string, unknown>, name: string): string | undefined {
    return args[name] === undefined ? undefined : HeraldChannel.string(args, name);
  }

  private static options(args: Record<string, unknown>): QuestionOption[] {
    const value = args.options;
    if (value === undefined) return [];
    const valid =
      Array.isArray(value) &&
      value.every((o) => typeof o === 'object' && o !== null && typeof o.id === 'string' && typeof o.text === 'string');
    if (!valid) throw new ToolArgsError('аргумент «options» — ожидается массив { id, text }');
    return (value as QuestionOption[]).map((o) => ({ id: o.id, text: o.text }));
  }

  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
