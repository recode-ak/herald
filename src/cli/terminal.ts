import { join } from 'node:path';
import type { Clock } from '../app/ports.ts';
import { AgentLauncher, LaunchError } from '../terminal/launcher.ts';
import { SelfReset } from '../terminal/reset.ts';
import { HookSignals } from '../terminal/signals.ts';
import type { Terminal } from '../terminal/terminal.ts';
import type { TmuxRun } from '../terminal/tmux.ts';
import { type Args, UsageError } from './args.ts';

type Env = Record<string, string | undefined>;

export interface TerminalCommandsDeps {
  env: Env;
  clock: Clock;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Весь stdin процесса (JSON хука). */
  stdin: () => Promise<string>;
  /** Запустить `herald <argv>` фоном отдельной сессией, вывод — в `log`. */
  detach: (argv: string[], log: string) => Promise<void>;
  /** Терминал панели tmux. */
  terminal: (pane: string) => Terminal;
  /** Уведомление человеку (herald notify). */
  notify: (text: string) => Promise<void>;
  tmux: TmuxRun;
  /** Полный путь к `claude`; не найден — `undefined`. */
  claude: () => string | undefined;
  cwd: string;
}

/** Команды CLI про окна агентов в tmux: `herald hook` (метки хуков), `herald self` (самосброс), `herald spawn` (новое окно). */
export class TerminalCommands {
  static readonly DEFAULT_TIMEOUT_S = 600;
  static readonly SPAWN_TIMEOUT_S = 60;
  static readonly SPAWN_SESSION = 'agents';

  constructor(private readonly deps: TerminalCommandsDeps) {}

  /**
   * Хук Claude Code (`Stop`, `SessionStart`): метка для панели `TMUX_PANE`.
   * Всегда код 0 и пустой stdout — хук не должен мешать окну (stdout `SessionStart` попадает в контекст агента).
   */
  async hook(): Promise<number> {
    const pane = this.pane();
    if (!pane) return 0;
    try {
      const signal = HookSignals.parse(await this.deps.stdin(), this.deps.clock.now());
      if (signal) new HookSignals(HookSignals.dirOf(this.deps.env)).record(pane, signal);
    } catch (error) {
      this.deps.err(`herald hook: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return 0;
  }

  /**
   * Самосброс: набрать в своё окно команду и сообщение (`SelfReset`). Без `--foreground` — запустить себя фоном
   * и сразу ответить: ждать конца хода внутри хода нельзя.
   */
  async self(args: Args): Promise<number> {
    const command = args.positional.join(' ').trim();
    if (!command.startsWith('/') || command.includes('\n'))
      throw new UsageError('self: нужна команда с «/» в одну строку, например /clear');
    const pane = this.pane();
    if (!pane) {
      this.deps.err('herald self: окно агента не в tmux (нет TMUX_PANE) — набрать команду некуда\n');
      return 1;
    }
    const message = args.value('message');
    const timeoutMs = args.seconds('timeout') ?? TerminalCommands.DEFAULT_TIMEOUT_S * 1_000;
    const delayMs = args.seconds('delay');
    if (!args.has('foreground')) {
      const log = join(HookSignals.dirOf(this.deps.env), '..', 'self', `${pane.replace(/^%/, '')}.log`);
      await this.deps.detach(
        [
          'self',
          '--foreground',
          '--timeout',
          String(timeoutMs / 1_000),
          ...(delayMs !== undefined ? ['--delay', String(delayMs / 1_000)] : []),
          ...(message !== undefined ? ['--message', message] : []),
          '--',
          command,
        ],
        log,
      );
      this.print({ ok: true, pane, log });
      return 0;
    }
    const outcome = await new SelfReset({
      pane,
      terminal: this.deps.terminal(pane),
      signals: new HookSignals(HookSignals.dirOf(this.deps.env)),
      clock: this.deps.clock,
      notify: this.deps.notify,
    }).run({
      command,
      ...(message !== undefined && { message }),
      timeoutMs,
      ...(delayMs !== undefined && { delayMs }),
    });
    this.print(outcome);
    return outcome.ok ? 0 : 1;
  }

  /** Новое окно агента (`AgentLauncher`): Claude Code с каналом в tmux-сессии `agents`. */
  async spawn(args: Args): Promise<number> {
    const [dir, ...extra] = args.positional;
    if (!dir || extra.length > 0) throw new UsageError('spawn: нужен один каталог (задача — в --prompt)');
    const claude = this.deps.claude();
    const home = this.deps.env.HOME;
    try {
      if (!claude) throw new LaunchError('claude не найден в PATH');
      if (!home) throw new LaunchError('нет HOME');
      const prompt = args.value('prompt');
      const launched = await new AgentLauncher({
        tmux: this.deps.tmux,
        home,
        cwd: this.deps.cwd,
        claude,
        clock: this.deps.clock,
      }).launch({
        dir,
        ...(prompt !== undefined && { prompt }),
        tmuxSession: args.value('tmux') ?? TerminalCommands.SPAWN_SESSION,
        timeoutMs: args.seconds('timeout') ?? TerminalCommands.SPAWN_TIMEOUT_S * 1_000,
      });
      this.print({ ok: true, ...launched });
      return 0;
    } catch (error) {
      if (!(error instanceof LaunchError)) throw error;
      this.deps.err(`herald spawn: ${error.message}\n`);
      return 1;
    }
  }

  private pane(): string | undefined {
    return this.deps.env.TMUX_PANE?.trim() || undefined;
  }

  private print(value: unknown): void {
    this.deps.out(`${JSON.stringify(value)}\n`);
  }
}
