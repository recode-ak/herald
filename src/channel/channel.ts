import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AskItem, AskRequest, ItemAnswerRequest } from '../client/client.ts';
import type { InboxKind } from '../domain/inbox.ts';
import type { Choice, QuestionOption } from '../domain/question.ts';
import type { InboxItemWire, QuestionWire } from '../http/wire.ts';
import type { Terminal } from '../terminal/terminal.ts';

/** Что каналу нужно от клиента herald (реализация — `HeraldClient`, в тестах — `FakeHerald`). */
export interface ChannelHerald {
  notify(text: string): Promise<void>;
  status(text: string): Promise<void>;
  title(text: string): Promise<void>;
  bye(): Promise<void>;
  ask(request: AskRequest): Promise<QuestionWire>;
  decide(id: string, answers: Choice | readonly ItemAnswerRequest[], reason: string): Promise<QuestionWire>;
  answered(id: string, answers: Choice | readonly ItemAnswerRequest[]): Promise<QuestionWire>;
  toTerminal(id?: string): Promise<QuestionWire[]>;
  inbox(waitMs?: number, kinds?: readonly InboxKind[]): Promise<InboxItemWire[]>;
  ack(ids: readonly string[]): Promise<string[]>;
}

export interface HeraldChannelOptions {
  herald: ChannelHerald;
  /** Команды `/clear`, `/compact` набираются в окне агента. Нет — окно не в tmux: команды не выполняются, человеку уходит уведомление. */
  terminal?: Terminal;
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
  /**
   * Claude Code принимает события канала (запущен с флагом канала, см. `ClaudeLaunch`). По умолчанию — да.
   * Нет — входящие не отправляются событиями и не подтверждаются: агент забирает их инструментом `inbox`,
   * цикл берёт только команды терминала (и держит пульс).
   */
  events?: boolean;
  /** Без событий не предупреждать человека при старте (разовый `claude -p`). */
  silent?: boolean;
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

const COMMON = [
  'herald — связь с человеком через Telegram. Человек читает Telegram, а не эту сессию: всё, что он должен увидеть, отправляй инструментом reply (или notify). Вывод в транскрипт до него не доходит.',
  '',
  'Текст для человека (reply, notify, ask и варианты) — коротко, с абзацами; можно Markdown: **жирный**, _курсив_, `код`, блоки ```, [ссылка](https://…), списки «- ». Таблицы и прочее не поддержаны — уйдут как есть.',
  '',
];

const BATCH_AND_TERMINAL = [
  'Несколько связанных вопросов задавай одним ask с questions (до 10): человек получает их по одному, ответы приходят одним событием; срок timeout_seconds — на всю пачку. decide и answered по пачке — с answers: [{ item, option | text }] (decide без ответа на пункт берёт рекомендованный).',
  '',
  'Человек в терминале просит спросить здесь («тут», «в терминал», «спроси здесь») — вызови to_terminal (без question_id — все открытые вопросы сессии), задай вернувшиеся пункты своим UI (в Claude Code — AskUserQuestion) и закрой ответы инструментом answered. Решать сам переведённый вопрос нельзя.',
  '',
];

const WINDOWS = [
  'Окна агентов (CLI herald в Bash, окно должно быть в tmux):',
  '- человек просит открыть окно (агента) для другой задачи — `herald spawn <каталог> --prompt "<задача>"`: Claude Code с каналом в tmux-сессии agents, задача уходит ему первым сообщением; каталог — внутри домашнего;',
  '- человек просит закрыть это окно («закройся», «выйди») — последним действием хода `herald self /exit`;',
  '- сброс контекста самому (граница фазы и т. п.) — последним действием хода `herald self /clear --message "<с чего продолжить>"`; сообщение — всё, что будет знать чистый агент.',
  '',
];

const STATUS_AND_TITLE = [
  'status — короткий статус сессии на границах задач (в Telegram не отправляется, человек видит его по /status).',
  '',
  'title — название сессии в шапке её сообщений (например, «dmg-ui · Ф4»): по нему человек отличает параллельные окна одного проекта. Задай его в начале работы и обнови, когда сессия переходит к другой задаче.',
];

/** Инструкции с событиями: сообщения человека приходят в сессию сами. */
const EVENTS_INSTRUCTIONS = [
  ...COMMON,
  'Канал подключён: сообщения человека приходят как <channel source="herald" kind="..." item_id="...">:',
  '- kind="directive" — указание человека этой сессии; выполни его как просьбу пользователя.',
  '- kind="answer" question_id="..." — ответ на твой вопрос (option — id выбранного варианта).',
  '- kind="late-answer" question_id="..." — переигрывание: ответ пришёл после твоего решения по таймауту; реши, нужно ли переделать.',
  '- kind="to-terminal" question_id="..." — человек перевёл вопрос в терминал: задай неотвеченные пункты здесь своим UI (в Claude Code — AskUserQuestion) и закрой ответы инструментом answered.',
  '- kind="hold" question_id="..." — человек нажал «Жди меня»: decide по вопросу запрещён, не жди срока — жди ответа без таймаута.',
  '',
  'ask задаёт вопрос с вариантами и сразу возвращает id — не жди, продолжай работу; ответ придёт событием. С timeout_seconds: если к сроку ответа нет, прими рекомендованный вариант инструментом decide с причиной («по таймауту»). Без timeout_seconds решать нельзя — жди ответа. Человек ответил в терминале — закрой вопрос инструментом answered.',
  '',
  ...BATCH_AND_TERMINAL,
  ...WINDOWS,
  ...STATUS_AND_TITLE,
].join('\n');

/** Инструкции без событий: Claude Code запущен без флага канала, входящие агент забирает сам. */
const PULL_INSTRUCTIONS = [
  ...COMMON,
  'Канал не подключён: Claude Code запущен без `--dangerously-load-development-channels server:herald`, сообщения человека в сессию сами не приходят. Забирай их инструментом inbox — на границе каждой задачи и когда ждёшь ответа на ask (inbox с wait_seconds, до 600):',
  '- kind=directive — указание человека этой сессии; выполни его как просьбу пользователя.',
  '- kind=answer question_id=... — ответ на твой вопрос (option — id выбранного варианта).',
  '- kind=late-answer question_id=... — переигрывание: ответ пришёл после твоего решения по таймауту; реши, нужно ли переделать.',
  '- kind=to-terminal question_id=... — человек перевёл вопрос в терминал: задай неотвеченные пункты здесь своим UI и закрой ответы инструментом answered.',
  '- kind=hold question_id=... — человек нажал «Жди меня»: decide по вопросу запрещён — жди ответа без таймаута (inbox с wait_seconds).',
  '',
  'ask задаёт вопрос с вариантами и сразу возвращает id; ответ забери инструментом inbox. С timeout_seconds: если к сроку ответа нет, прими рекомендованный вариант инструментом decide с причиной («по таймауту»). Без timeout_seconds решать нельзя — жди ответа. Человек ответил в терминале — закрой вопрос инструментом answered.',
  '',
  ...BATCH_AND_TERMINAL,
  ...WINDOWS,
  ...STATUS_AND_TITLE,
].join('\n');

/** Что агент забирает инструментом `inbox`; команды терминала берёт цикл. */
const PULL_KINDS: readonly InboxKind[] = ['directive', 'answer', 'late-answer', 'to-terminal', 'hold'];

const OPTIONS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { id: { type: 'string', description: 'короткий: A, B…' }, text: { type: 'string' } },
    required: ['id', 'text'],
  },
};

const ANSWERS_SCHEMA = {
  type: 'array',
  description: 'ответы по пунктам пачки вместо option/text',
  items: {
    type: 'object',
    properties: {
      item: { type: 'number', description: 'номер пункта, с 1' },
      option: { type: 'string', description: 'id варианта' },
      text: { type: 'string', description: 'свободный ответ вместо варианта' },
    },
    required: ['item'],
  },
};

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
        options: OPTIONS_SCHEMA,
        recommended: { type: 'string', description: 'id рекомендованного варианта' },
        questions: {
          type: 'array',
          description:
            'пачка связанных вопросов (до 10) вместо text/options/recommended: человек получает их по одному, ответы придут одним событием',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              options: OPTIONS_SCHEMA,
              recommended: { type: 'string', description: 'id рекомендованного варианта' },
            },
            required: ['text'],
          },
        },
        timeout_seconds: {
          type: 'number',
          description:
            'сколько ждёшь ответа (на всю пачку), прежде чем решить сам (decide); человек видит срок и кнопку «Жди меня». Без него decide запрещён — ждёшь ответа',
        },
      },
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
        answers: {
          ...ANSWERS_SCHEMA,
          description: 'ответы по пунктам пачки вместо option/text; пункт без ответа — рекомендованный ([] — все)',
        },
        reason: { type: 'string', description: 'почему, например «по таймауту»' },
      },
      required: ['question_id', 'reason'],
    },
  },
  {
    name: 'answered',
    description:
      'Человек ответил на вопрос в терминале, а не в Telegram: закрыть вопрос его ответом. Сообщение в Telegram обновится, кнопки уберутся.',
    inputSchema: {
      type: 'object',
      properties: {
        question_id: { type: 'string' },
        option: { type: 'string', description: 'id выбранного варианта' },
        text: { type: 'string', description: 'свободный ответ вместо варианта' },
        answers: ANSWERS_SCHEMA,
      },
      required: ['question_id'],
    },
  },
  {
    name: 'to_terminal',
    description:
      'Человек ответит в терминале: вопрос (или, без question_id, все открытые вопросы сессии) уходит из Telegram. Возвращает пункты — задай их своим UI и закрой ответы инструментом answered.',
    inputSchema: { type: 'object', properties: { question_id: { type: 'string' } } },
  },
  {
    name: 'status',
    description: 'Обновить статус сессии (что делаю сейчас). В Telegram не отправляется; человек видит его по /status.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'title',
    description:
      'Назвать сессию (≤ 60 символов): название идёт в шапку её сообщений в Telegram — так человек отличает параллельные окна одного проекта.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

const INBOX_TOOL = {
  name: 'inbox',
  description:
    'Забрать сообщения человека из Telegram: указания, ответы на вопросы, переигрывания. Забранные считаются прочитанными. wait_seconds — ждать первых, если пока пусто (до 600).',
  inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number' } } },
};

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
  private closing: Promise<void> | undefined;
  private loop: Promise<void> | undefined;
  /** Вопросы-подтверждения: id вопроса → request_id; решённые остаются с `undefined` (поздние ответы — не события). */
  private readonly permissions = new Map<string, string | undefined>();
  private readonly events: boolean;
  static readonly PREVIEW_MAX = 1_000;
  static readonly INBOX_WAIT_MAX_S = 600;

  constructor(private readonly options: HeraldChannelOptions) {
    this.herald = options.herald;
    this.log = options.log ?? ((m) => process.stderr.write(`${m}\n`));
    this.events = options.events ?? true;
    // Подтверждение действий идёт только через события канала.
    const permissionRelay = this.events && options.permissionRelay === true;
    this.server = new Server(
      { name: 'herald', version: '0.1.0' },
      {
        capabilities: {
          tools: {},
          experimental: {
            'claude/channel': {},
            ...(permissionRelay && { 'claude/channel/permission': {} }),
          },
        },
        instructions: this.events ? EVENTS_INSTRUCTIONS : PULL_INSTRUCTIONS,
      },
    );
    if (permissionRelay) {
      // Схемы zod у этого уведомления нет — ловим его в fallback.
      this.server.fallbackNotificationHandler = async (n) => {
        if (n.method === 'notifications/claude/channel/permission_request') {
          await this.askPermission(n.params as unknown as PermissionRequest);
        }
      };
    }
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.events ? TOOLS : [...TOOLS, INBOX_TOOL],
    }));
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
    if (!this.events && !this.options.silent) void this.warnNoEvents();
  }

  /** Человек узнаёт сразу, что указания этому окну не придут мгновенно. */
  private async warnNoEvents(): Promise<void> {
    try {
      await this.herald.notify(
        '⚠️ Окно запущено без канала: указания и ответы сессия заберёт сама (инструмент inbox), не сразу. Чтобы приходили сразу — запуск с `--dangerously-load-development-channels server:herald`.',
      );
    } catch (error) {
      this.log(`herald channel: предупреждение — ${HeraldChannel.message(error)}`);
    }
  }

  /**
   * Остановить цикл, сообщить herald о закрытии окна (best effort) и закрыть MCP.
   * Висящий long poll не ждём: его результат будет отброшен.
   */
  close(): Promise<void> {
    // Повторный вызов (onclose при закрытии MCP) ждёт то же закрытие.
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.running = false;
    try {
      await this.herald.bye();
    } catch (error) {
      this.log(`herald channel: bye — ${(error as Error).message}`);
    }
    await this.server.close();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const items = await this.herald.inbox(this.options.inboxWaitMs ?? 50_000, this.events ? [] : ['command']);
        if (!this.running) return;
        for (const item of items) {
          if (item.questionId !== undefined && this.permissions.has(item.questionId)) await this.permit(item);
          else if (item.kind === 'command') await this.execute(item.text);
          else await this.deliver(item);
        }
        if (items.length > 0) await this.herald.ack(items.map((i) => i.id));
      } catch (error) {
        this.log(`herald channel: входящие: ${HeraldChannel.message(error)}`);
        await Bun.sleep(this.options.retryDelayMs ?? 5_000);
      }
    }
  }

  /** Команда терминала: набрать в окне агента; не вышло — сказать человеку (прочтение всё равно подтверждается). */
  private async execute(command: string): Promise<void> {
    const { terminal } = this.options;
    try {
      if (!terminal) throw new Error('окно агента запущено не в tmux.');
      await terminal.send(command);
    } catch (error) {
      await this.herald.notify(`⚠️ ${command} не выполнена: ${HeraldChannel.message(error)}`);
      return;
    }
    // Окно то же, а разговор новый: прежний статус в /sessions сбивал бы с толку.
    // Сбой статуса — только в лог: иначе прочтение не подтвердится и команда выполнится ещё раз.
    const status = HeraldChannel.AFTER_COMMAND[command];
    if (status)
      await this.herald.status(status).catch((e) => this.log(`herald channel: статус: ${HeraldChannel.message(e)}`));
  }

  /** Статус сессии после команды терминала. */
  private static readonly AFTER_COMMAND: Readonly<Record<string, string>> = {
    '/clear': '🧹 /clear — контекст сброшен, жду указаний',
    '/compact': '🗜 /compact — контекст сжат',
  };

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
    await this.server.notification({
      method: 'notifications/claude/channel',
      params: { content: HeraldChannel.content(item), meta: HeraldChannel.meta(item) },
    });
  }

  /** Инструмент `inbox`: входящие текстом, затем подтверждение прочтения. */
  private async pull(args: Record<string, unknown>): Promise<ToolResult> {
    const wait = args.wait_seconds;
    if (wait !== undefined && (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0))
      throw new ToolArgsError('аргумент «wait_seconds» — ожидается число ≥ 0');
    const waitMs = Math.min(wait ?? 0, HeraldChannel.INBOX_WAIT_MAX_S) * 1_000;
    const items = await this.herald.inbox(waitMs, PULL_KINDS);
    if (items.length === 0) return HeraldChannel.ok('входящих нет');
    await this.herald.ack(items.map((i) => i.id));
    const text = items.map((item) => {
      const header = Object.entries(HeraldChannel.meta(item))
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      return `${header}\n${HeraldChannel.content(item)}`;
    });
    return HeraldChannel.ok(text.join('\n\n'));
  }

  private static content(item: InboxItemWire): string {
    return item.kind === 'answer'
      ? `Ответ на вопрос ${item.questionId}: ${item.text}`
      : item.kind === 'late-answer'
        ? `Переигрывание вопроса ${item.questionId}: ${item.text}`
        : item.text;
  }

  private static meta(item: InboxItemWire): Record<string, string> {
    return {
      kind: item.kind,
      item_id: item.id,
      ...(item.questionId !== undefined && { question_id: item.questionId }),
      ...(item.option !== undefined && { option: item.option }),
    };
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
        case 'title':
          await this.herald.title(HeraldChannel.string(args, 'text'));
          return HeraldChannel.ok('название сессии обновлено');
        case 'ask': {
          const timeout = args.timeout_seconds;
          if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 0))
            throw new ToolArgsError('аргумент «timeout_seconds» — ожидается целое число ≥ 0');
          const timeoutMs = timeout !== undefined ? { timeoutMs: timeout * 1_000 } : {};
          let request: AskRequest;
          if (args.questions !== undefined) {
            if (args.text !== undefined) throw new ToolArgsError('нужен text или questions, не оба');
            request = { questions: HeraldChannel.questions(args.questions), ...timeoutMs };
          } else {
            request = { ...HeraldChannel.askItem(args), ...timeoutMs };
          }
          const question = await this.herald.ask(request);
          const what = question.items.length > 1 ? `пачка из ${question.items.length} вопросов` : 'вопрос';
          return HeraldChannel.ok(
            this.events
              ? `${what} ${question.id} задан(а); ответ придёт событием <channel kind="answer" question_id="${question.id}">`
              : `${what} ${question.id} задан(а); ответ забери инструментом inbox (kind=answer question_id=${question.id})`,
          );
        }
        case 'answered': {
          const question = await this.herald.answered(
            HeraldChannel.string(args, 'question_id'),
            HeraldChannel.answers(args),
          );
          return HeraldChannel.ok(`вопрос ${question.id} закрыт ответом из терминала`);
        }
        case 'decide': {
          const answers = HeraldChannel.answers(args);
          const question = await this.herald.decide(
            HeraldChannel.string(args, 'question_id'),
            answers,
            HeraldChannel.string(args, 'reason'),
          );
          return HeraldChannel.ok(`решение по вопросу ${question.id} принято`);
        }
        case 'to_terminal': {
          const moved = await this.herald.toTerminal(HeraldChannel.optionalString(args, 'question_id'));
          return HeraldChannel.ok(HeraldChannel.terminalText(moved));
        }
        case 'inbox':
          if (this.events)
            throw new ToolArgsError('нет инструмента inbox: канал подключён, входящие приходят событиями');
          return await this.pull(args);
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

  /** Одиночный вопрос: `text`, `options`, `recommended`. */
  private static askItem(args: Record<string, unknown>): AskItem {
    const recommended = HeraldChannel.optionalString(args, 'recommended');
    return {
      text: HeraldChannel.string(args, 'text'),
      options: HeraldChannel.options(args),
      ...(recommended !== undefined && { recommended }),
    };
  }

  private static questions(value: unknown): AskItem[] {
    if (!Array.isArray(value) || value.length === 0)
      throw new ToolArgsError('аргумент «questions» — ожидается непустой массив { text, options?, recommended? }');
    return value.map((q, i) => {
      if (typeof q !== 'object' || q === null) throw new ToolArgsError(`questions[${i}] — ожидается объект`);
      try {
        return HeraldChannel.askItem(q as Record<string, unknown>);
      } catch (error) {
        throw new ToolArgsError(`questions[${i}]: ${HeraldChannel.message(error)}`);
      }
    });
  }

  /** `answers` (по пунктам) или `option` / `text`. */
  private static answers(args: Record<string, unknown>): Choice | ItemAnswerRequest[] {
    const value = args.answers;
    if (value === undefined) return HeraldChannel.choice(args);
    if (args.option !== undefined || args.text !== undefined)
      throw new ToolArgsError('нужен answers или option/text, не оба');
    if (!Array.isArray(value)) throw new ToolArgsError('аргумент «answers» — ожидается массив { item, option | text }');
    return value.map((a, i) => {
      const raw = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>;
      const item = raw.item;
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1)
        throw new ToolArgsError(`answers[${i}]: «item» — номер пункта ≥ 1`);
      try {
        const choice = HeraldChannel.choice(raw);
        return 'option' in choice ? { item, option: choice.option } : { item, text: choice.text };
      } catch (error) {
        throw new ToolArgsError(`answers[${i}]: ${HeraldChannel.message(error)}`);
      }
    });
  }

  /** Результат `to_terminal`: по вопросу — что уже отвечено и что спросить. */
  private static terminalText(questions: readonly QuestionWire[]): string {
    if (questions.length === 0) return 'открытых вопросов нет';
    const blocks = questions.map((q) => {
      const line = (n: number, it: QuestionWire['items'][number]) => {
        const r = it.resolution;
        if (r) {
          const answer =
            r.option !== undefined ? `${r.option}: ${it.options.find((o) => o.id === r.option)?.text ?? ''}` : r.text;
          return `${n}. ${it.text} — ${answer}`;
        }
        const options = it.options.map((o) => `${o.id}: ${o.text}${it.recommended === o.id ? ' ⭐' : ''}`).join('; ');
        return `${n}. ${it.text} — ${options ? `варианты: ${options}` : 'свободный ответ'}`;
      };
      const done = q.items.flatMap((it, i) => (it.resolution ? [line(i + 1, it)] : []));
      const ask = q.items.flatMap((it, i) => (it.resolution ? [] : [line(i + 1, it)]));
      return [`${q.id}${done.length > 0 ? ` (уже ответил: ${done.join('; ')})` : ''}`, ...ask].join('\n');
    });
    return [
      'Переведено в терминал — спроси человека здесь своим UI и закрой ответы инструментом answered:',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  }

  /** `option` или `text` — ровно одно из них. */
  private static choice(args: Record<string, unknown>): Choice {
    const option = HeraldChannel.optionalString(args, 'option');
    const text = HeraldChannel.optionalString(args, 'text');
    if ((option === undefined) === (text === undefined)) throw new ToolArgsError('нужен option или text');
    return option !== undefined ? { option } : { text: text as string };
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
