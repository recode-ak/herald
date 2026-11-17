import { HookSignals } from '../terminal/signals.ts';

type Env = Record<string, string | undefined>;

export interface TerminalCommandsDeps {
  env: Env;
  now: () => number;
  err: (text: string) => void;
  /** Весь stdin процесса (JSON хука). */
  stdin: () => Promise<string>;
}

/** Команды CLI про окно агента в tmux: `herald hook` (метки хуков Claude Code). */
export class TerminalCommands {
  constructor(private readonly deps: TerminalCommandsDeps) {}

  /**
   * Хук Claude Code (`Stop`, `SessionStart`): метка для панели `TMUX_PANE`.
   * Всегда код 0 и пустой stdout — хук не должен мешать окну (stdout `SessionStart` попадает в контекст агента).
   */
  async hook(): Promise<number> {
    const pane = this.deps.env.TMUX_PANE?.trim();
    if (!pane) return 0;
    try {
      const signal = HookSignals.parse(await this.deps.stdin(), this.deps.now());
      if (signal) new HookSignals(HookSignals.dirOf(this.deps.env)).record(pane, signal);
    } catch (error) {
      this.deps.err(`herald hook: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return 0;
  }
}
