import type { Clock } from '../app/ports.ts';
import {
  type AskItem,
  type AskRequest,
  HeraldClient,
  HeraldClientError,
  type ItemAnswerRequest,
} from '../client/client.ts';
import { ClientConfig, ClientConfigError } from '../client/config.ts';
import { SessionLocator } from '../client/locator.ts';
import type { Choice, QuestionOption, Resolution } from '../domain/question.ts';
import type { QuestionWire } from '../http/wire.ts';
import type { Terminal } from '../terminal/terminal.ts';
import { TmuxTerminal } from '../terminal/tmux.ts';
import { Args, type ArgsSpec, UsageError } from './args.ts';
import { TerminalCommands } from './terminal.ts';

export interface CliDeps {
  env: Record<string, string | undefined>;
  cwd: string;
  clock: Clock;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Весь stdin процесса (`herald hook`); нет — пусто. */
  stdin?: () => Promise<string>;
  /** Запустить `herald <argv>` фоном отдельной сессией (`herald self`); нет — ошибка. */
  detach?: (argv: string[], log: string) => Promise<void>;
  /** Терминал панели tmux (`herald self`); по умолчанию — `TmuxTerminal`. */
  terminal?: (pane: string) => Terminal;
}

/** Ответ на пункт в выводе CLI. */
export interface ItemResult {
  item: number;
  by: 'human' | 'agent';
  option?: string;
  text?: string;
  reason?: string;
}

/**
 * Ответ на вопрос в выводе CLI. `timeout` — ответа нет (код 2), `terminal` — человек перевёл вопрос в терминал
 * (код 3: спроси у себя и закрой `herald answered`). У пачки — ответы по пунктам в `items`.
 */
export interface AskResult {
  id: string;
  status: 'answered' | 'decided' | 'timeout' | 'terminal';
  by?: 'human' | 'agent';
  option?: string;
  text?: string;
  reason?: string;
  items?: ItemResult[];
}

const USAGE = `herald — вопросы и уведомления человеку через Telegram

  herald notify <текст>                         уведомление
  herald status <текст>                         статус сессии (в Telegram не отправляется)
  herald title <текст>                          название сессии — в шапке её сообщений
  herald ask <вопрос> [-o "A: текст"]… [--recommended A] [--timeout <с>]
                                                вопрос; ждёт ответа (без --timeout — бесконечно,
                                                и decide по нему запрещён; после «Жди меня» —
                                                тоже бесконечно)
  herald ask --questions '<JSON>' [--timeout <с>]
                                                пачка связанных вопросов: человек получает их
                                                по одному, ответы — все сразу (items в выводе);
                                                JSON — [{ "text", "options": [{ "id", "text" }], "recommended" }]
  herald decide <id> (<вариант> | --text <текст> | --answers '<JSON>') --reason <причина>
                                                решение агента (например, по таймауту); у пачки —
                                                --answers '[{ "item": 2, "text": "…" }]', прочие пункты —
                                                рекомендованные ('[]' — все)
  herald answered <id> (<вариант> | --text <текст> | --answers '<JSON>')
                                                человек ответил в терминале: закрыть вопрос
  herald to-terminal [<id>]                     человек ответит в терминале: вопрос или все
                                                открытые вопросы сессии уходят из Telegram
  herald inbox [--wait <с>] [--ack]             входящие: ответы, поздние ответы, указания,
                                                переводы в терминал
  herald ack <id>…                              подтвердить прочтение входящих
  herald self <команда> [--message <текст>] [--timeout <с>] [--delay <с>] [--foreground]
                                                самосброс: в своё окно tmux набрать команду
                                                (/clear, /compact…), затем сообщение для
                                                продолжения; моменты — по хукам Stop и SessionStart
                                                (срок каждого — --timeout, по умолчанию 600 с),
                                                без хуков — --delay: сообщение через N с.
                                                Идёт фоном, сразу отвечает; не вышло — notify
  herald hook                                   хук Claude Code (Stop, SessionStart): JSON хука
                                                из stdin → метка окна tmux; всегда код 0

  Общие: --session <имя> (или HERALD_SESSION) — явная сессия вместо корня git.
  Вывод — JSON в stdout. Коды: 0 — готово, 2 — ask без ответа по таймауту,
  3 — ask переведён в терминал (спроси у себя, закрой herald answered), 1 — ошибка.
  Настройки: ~/.config/herald/config.json { serverUrl, token, host } или HERALD_URL, HERALD_TOKEN, HERALD_HOST.
`;

const COMMON = { values: ['session'], switches: ['help'] } as const;

/** CLI herald: разбор аргументов → клиент → JSON и код выхода. */
export class Cli {
  constructor(private readonly deps: CliDeps) {}

  async run(argv: readonly string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (command === '--help' || command === '-h' || command === 'help') {
      this.deps.out(USAGE);
      return 0;
    }
    try {
      switch (command) {
        case 'notify':
          return await this.notify(rest);
        case 'status':
          return await this.status(rest);
        case 'title':
          return await this.title(rest);
        case 'ask':
          return await this.ask(rest);
        case 'decide':
          return await this.decide(rest);
        case 'answered':
          return await this.answered(rest);
        case 'to-terminal':
          return await this.toTerminal(rest);
        case 'inbox':
          return await this.inbox(rest);
        case 'ack':
          return await this.ack(rest);
        case 'hook':
          return await this.terminal().hook();
        case 'self': {
          const args = this.parse(rest, { values: ['message', 'timeout', 'delay'], switches: ['foreground'] });
          return await this.terminal(args).self(args);
        }
        default:
          throw new UsageError(command ? `неизвестная команда «${command}»` : 'нужна команда');
      }
    } catch (error) {
      if (error instanceof UsageError) {
        this.deps.err(`herald: ${error.message}\n\n${USAGE}`);
        return 1;
      }
      if (error instanceof HeraldClientError || error instanceof ClientConfigError) {
        this.deps.err(`herald: ${error.message}\n`);
        return 1;
      }
      throw error;
    }
  }

  private async notify(argv: readonly string[]): Promise<number> {
    const args = this.parse(argv, {});
    await this.client(args).notify(Cli.text(args, 'текст уведомления'));
    return this.print({ ok: true });
  }

  private async status(argv: readonly string[]): Promise<number> {
    const args = this.parse(argv, {});
    await this.client(args).status(Cli.text(args, 'текст статуса'));
    return this.print({ ok: true });
  }

  private async title(argv: readonly string[]): Promise<number> {
    const args = this.parse(argv, {});
    await this.client(args).title(Cli.text(args, 'название сессии'));
    return this.print({ ok: true });
  }

  private async ask(argv: readonly string[]): Promise<number> {
    const args = this.parse(argv, { values: ['recommended', 'timeout', 'questions'], lists: ['o', 'option'] });
    const timeoutMs = args.seconds('timeout');
    const client = this.client(args);
    const raw = args.value('questions');
    let question: AskRequest;
    if (raw !== undefined) {
      if (args.positional.length > 0 || args.list('o').length > 0 || args.list('option').length > 0) {
        throw new UsageError('ask: --questions — вместо текста вопроса и -o');
      }
      question = { questions: Cli.questions(raw) };
    } else {
      const options = [...args.list('o'), ...args.list('option')].map(Cli.option);
      const recommended = args.value('recommended');
      question = {
        text: Cli.text(args, 'текст вопроса'),
        options,
        ...(recommended !== undefined && { recommended }),
      };
    }
    const asked = await client.ask({ ...question, ...(timeoutMs !== undefined && { timeoutMs }) });
    let answer = await client.awaitQuestion(asked.id, timeoutMs);
    // «Жди меня»: решать агенту нельзя — ждём человека без срока, а не выходим с «нет ответа».
    if (answer.status === 'open' && answer.heldAt !== undefined && answer.terminalAt === undefined) {
      answer = await client.awaitQuestion(asked.id);
    }
    const result = Cli.result(answer);
    this.print(result);
    return result.status === 'timeout' ? 2 : result.status === 'terminal' ? 3 : 0;
  }

  private async decide(argv: readonly string[]): Promise<number> {
    const args = this.parse(argv, { values: ['text', 'reason', 'answers'] });
    const { id, answers } = Cli.answersOf(args, 'decide');
    const reason = args.value('reason');
    if (!reason?.trim()) throw new UsageError('decide: нужна --reason');
    return this.print(Cli.result(await this.client(args).decide(id, answers, reason)));
  }

  private async answered(argv: readonly string[]): Promise<number> {
    const args = this.parse(argv, { values: ['text', 'answers'] });
    const { id, answers } = Cli.answersOf(args, 'answered');
    return this.print(Cli.result(await this.client(args).answered(id, answers)));
  }

  private async toTerminal(argv: readonly string[]): Promise<number> {
    const args = this.parse(argv, {});
    const [id, ...extra] = args.positional;
    if (extra.length > 0) throw new UsageError('to-terminal: лишние аргументы');
    return this.print(await this.client(args).toTerminal(id));
  }

  private async inbox(argv: readonly string[]): Promise<number> {
    const args = this.parse(argv, { values: ['wait'], switches: ['ack'] });
    if (args.positional.length > 0) throw new UsageError('inbox: лишние аргументы');
    const client = this.client(args);
    const items = await client.inbox(args.seconds('wait') ?? 0);
    if (args.has('ack') && items.length > 0) await client.ack(items.map((i) => i.id));
    return this.print(items);
  }

  private async ack(argv: readonly string[]): Promise<number> {
    const args = this.parse(argv, {});
    if (args.positional.length === 0) throw new UsageError('ack: нужен хотя бы один id');
    return this.print({ read: await this.client(args).ack(args.positional) });
  }

  /** Команды окна tmux; `args` — для сессии уведомлений (`--session`). */
  private terminal(args?: Args): TerminalCommands {
    return new TerminalCommands({
      env: this.deps.env,
      clock: this.deps.clock,
      out: this.deps.out,
      err: this.deps.err,
      stdin: this.deps.stdin ?? (async () => ''),
      detach:
        this.deps.detach ??
        (async () => {
          throw new Error('запуск фоном недоступен');
        }),
      terminal: this.deps.terminal ?? ((pane) => new TmuxTerminal(pane)),
      notify: (text) => this.client(args ?? this.parse([], {})).notify(text),
    });
  }

  private parse(argv: readonly string[], spec: ArgsSpec): Args {
    return Args.parse(argv, {
      values: [...COMMON.values, ...(spec.values ?? [])],
      lists: spec.lists ?? [],
      switches: [...COMMON.switches, ...(spec.switches ?? [])],
    });
  }

  private client(args: Args): HeraldClient {
    const config = ClientConfig.load(this.deps.env);
    const session = new SessionLocator(config.host).locate({
      cwd: this.deps.cwd,
      name: args.value('session') ?? this.deps.env.HERALD_SESSION,
      agentProcess: Cli.pid(this.deps.env.CLAUDE_PID),
      agentSession: this.deps.env.CLAUDE_CODE_SESSION_ID ?? this.deps.env.PI_SESSION_ID,
    });
    return new HeraldClient({ serverUrl: config.serverUrl, token: config.token, session, clock: this.deps.clock });
  }

  private print(value: unknown): number {
    this.deps.out(`${JSON.stringify(value)}\n`);
    return 0;
  }

  /** pid из переменной окружения; не число — `undefined`. */
  private static pid(raw: string | undefined): number | undefined {
    const pid = Number(raw);
    return raw !== undefined && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  }

  /** Текст команды — позиционные аргументы через пробел. */
  private static text(args: Args, what: string): string {
    const text = args.positional.join(' ').trim();
    if (!text) throw new UsageError(`нужен ${what}`);
    return text;
  }

  /** `-o "A: SQLite"` → `{ id: 'A', text: 'SQLite' }`. */
  private static option(raw: string): QuestionOption {
    const at = raw.indexOf(':');
    const id = raw.slice(0, at).trim();
    const text = raw.slice(at + 1).trim();
    if (at < 0 || !id || !text) throw new UsageError(`вариант «${raw}» — ожидается «id: текст»`);
    return { id, text };
  }

  /** id и ответ: `<вариант>`, `--text` или `--answers '<JSON>'` — ровно одно. */
  private static answersOf(args: Args, command: string): { id: string; answers: Choice | ItemAnswerRequest[] } {
    const [id, option, ...extra] = args.positional;
    if (!id) throw new UsageError(`${command}: нужен id вопроса`);
    if (extra.length > 0) throw new UsageError(`${command}: лишние аргументы`);
    const text = args.value('text');
    const raw = args.value('answers');
    const given = [option, text, raw].filter((v) => v !== undefined).length;
    if (given !== 1) throw new UsageError(`${command}: нужен вариант, --text или --answers`);
    if (raw !== undefined) return { id, answers: Cli.itemAnswers(raw) };
    return { id, answers: option !== undefined ? { option } : { text: text as string } };
  }

  /** `--questions`: `[{ text, options?, recommended? }]`. */
  private static questions(raw: string): AskItem[] {
    const value = Cli.json(raw, '--questions');
    const ok =
      Array.isArray(value) &&
      value.every(
        (q) =>
          Cli.isObject(q) &&
          typeof q.text === 'string' &&
          (q.recommended === undefined || typeof q.recommended === 'string') &&
          (q.options === undefined ||
            (Array.isArray(q.options) &&
              q.options.every((o) => Cli.isObject(o) && typeof o.id === 'string' && typeof o.text === 'string'))),
      );
    if (!ok) throw new UsageError('--questions — ожидается [{ "text", "options": [{ "id", "text" }], "recommended" }]');
    return (value as Record<string, unknown>[]).map((q) => ({
      text: q.text as string,
      options: (q.options as QuestionOption[] | undefined)?.map((o) => ({ id: o.id, text: o.text })) ?? [],
      ...(q.recommended !== undefined && { recommended: q.recommended as string }),
    }));
  }

  /** `--answers`: `[{ item, option | text }]`. */
  private static itemAnswers(raw: string): ItemAnswerRequest[] {
    const value = Cli.json(raw, '--answers');
    const ok =
      Array.isArray(value) &&
      value.every(
        (a) =>
          Cli.isObject(a) &&
          Number.isSafeInteger(a.item) &&
          (typeof a.option === 'string') !== (typeof a.text === 'string'),
      );
    if (!ok) throw new UsageError('--answers — ожидается [{ "item": 1, "option": "A" } | { "item": 2, "text": "…" }]');
    return (value as Record<string, unknown>[]).map((a) =>
      typeof a.option === 'string'
        ? { item: a.item as number, option: a.option }
        : { item: a.item as number, text: a.text as string },
    );
  }

  private static json(raw: string, flag: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      throw new UsageError(`${flag} — не JSON`);
    }
  }

  private static isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private static result(q: QuestionWire): AskResult {
    if (q.status === 'open') return { id: q.id, status: q.terminalAt !== undefined ? 'terminal' : 'timeout' };
    if (q.items.length > 1) {
      return {
        id: q.id,
        status: q.status,
        items: q.items.flatMap((it, i) => (it.resolution ? [Cli.itemResult(i + 1, it.options, it.resolution)] : [])),
      };
    }
    const r = q.resolution;
    if (!r) return { id: q.id, status: 'timeout' };
    const { item: _, ...flat } = Cli.itemResult(1, q.options, r);
    return { id: q.id, status: q.status, ...flat };
  }

  private static itemResult(item: number, options: readonly QuestionOption[], r: Resolution): ItemResult {
    const text = r.text ?? options.find((o) => o.id === r.option)?.text;
    return {
      item,
      by: r.by,
      ...(r.option !== undefined && { option: r.option }),
      ...(text !== undefined && { text }),
      ...(r.reason !== undefined && { reason: r.reason }),
    };
  }
}
