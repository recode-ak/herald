import type { Clock } from '../app/ports.ts';
import { HeraldClient, HeraldClientError } from '../client/client.ts';
import { ClientConfig, ClientConfigError } from '../client/config.ts';
import { SessionLocator } from '../client/locator.ts';
import type { Choice, QuestionOption } from '../domain/question.ts';
import type { QuestionWire } from '../http/wire.ts';
import { Args, type ArgsSpec, UsageError } from './args.ts';

export interface CliDeps {
  env: Record<string, string | undefined>;
  cwd: string;
  clock: Clock;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Ответ на вопрос в выводе CLI. `timeout` — ответа нет (код 2). */
export interface AskResult {
  id: string;
  status: 'answered' | 'decided' | 'timeout';
  by?: 'human' | 'agent';
  option?: string;
  text?: string;
  reason?: string;
}

const USAGE = `herald — вопросы и уведомления человеку через Telegram

  herald notify <текст>                         уведомление
  herald status <текст>                         статус сессии (в Telegram не отправляется)
  herald title <текст>                          название сессии — в шапке её сообщений
  herald ask <вопрос> [-o "A: текст"]… [--recommended A] [--timeout <с>]
                                                вопрос; ждёт ответа (без --timeout — бесконечно)
  herald decide <id> (<вариант> | --text <текст>) --reason <причина>
                                                решение агента (например, по таймауту)
  herald inbox [--wait <с>] [--ack]             входящие: ответы, поздние ответы, указания
  herald ack <id>…                              подтвердить прочтение входящих

  Общие: --session <имя> (или HERALD_SESSION) — явная сессия вместо корня git.
  Вывод — JSON в stdout. Коды: 0 — готово, 2 — ask без ответа по таймауту, 1 — ошибка.
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
        case 'inbox':
          return await this.inbox(rest);
        case 'ack':
          return await this.ack(rest);
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
    const args = this.parse(argv, { values: ['recommended', 'timeout'], lists: ['o', 'option'] });
    const options = [...args.list('o'), ...args.list('option')].map(Cli.option);
    const recommended = args.value('recommended');
    const timeoutMs = args.seconds('timeout');
    const client = this.client(args);
    const asked = await client.ask({
      text: Cli.text(args, 'текст вопроса'),
      options,
      ...(recommended !== undefined && { recommended }),
    });
    const result = Cli.result(await client.awaitQuestion(asked.id, timeoutMs));
    this.print(result);
    return result.status === 'timeout' ? 2 : 0;
  }

  private async decide(argv: readonly string[]): Promise<number> {
    const args = this.parse(argv, { values: ['text', 'reason'] });
    const [id, option, ...extra] = args.positional;
    if (!id) throw new UsageError('decide: нужен id вопроса');
    if (extra.length > 0) throw new UsageError('decide: лишние аргументы');
    const text = args.value('text');
    if ((option === undefined) === (text === undefined)) throw new UsageError('decide: нужен вариант или --text');
    const reason = args.value('reason');
    if (!reason?.trim()) throw new UsageError('decide: нужна --reason');
    const choice: Choice = option !== undefined ? { option } : { text: text as string };
    return this.print(Cli.result(await this.client(args).decide(id, choice, reason)));
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
      agentSession: this.deps.env.CLAUDE_CODE_SESSION_ID ?? this.deps.env.PI_SESSION_ID,
    });
    return new HeraldClient({ serverUrl: config.serverUrl, token: config.token, session, clock: this.deps.clock });
  }

  private print(value: unknown): number {
    this.deps.out(`${JSON.stringify(value)}\n`);
    return 0;
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

  private static result(q: QuestionWire): AskResult {
    const r = q.resolution;
    if (q.status === 'open' || !r) return { id: q.id, status: 'timeout' };
    const text = r.text ?? q.options.find((o) => o.id === r.option)?.text;
    return {
      id: q.id,
      status: q.status,
      by: r.by,
      ...(r.option !== undefined && { option: r.option }),
      ...(text !== undefined && { text }),
      ...(r.reason !== undefined && { reason: r.reason }),
    };
  }
}
