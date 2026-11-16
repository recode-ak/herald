import type { Terminal } from './channel.ts';

type Env = Record<string, string | undefined>;
/** Запуск `tmux` с аргументами; ненулевой код — исключение. */
type TmuxRun = (args: string[]) => Promise<void>;

/**
 * Терминал окна агента в tmux: команда набирается в панель так, будто её ввёл человек.
 * Поле ввода сначала очищается (Ctrl+U; набранное возвращает Ctrl+Y), иначе команда приклеится к черновику.
 * Если агент занят, Claude Code ставит команду в очередь и выполняет после хода.
 */
export class TmuxTerminal implements Terminal {
  constructor(
    private readonly pane: string,
    private readonly tmux: TmuxRun = TmuxTerminal.run,
  ) {}

  /** Панель процесса из `TMUX_PANE` (наследуется от Claude Code); вне tmux — `undefined`. */
  static fromEnv(env: Env): TmuxTerminal | undefined {
    const pane = env.TMUX_PANE?.trim();
    return pane ? new TmuxTerminal(pane) : undefined;
  }

  async send(command: string): Promise<void> {
    await this.tmux(['send-keys', '-t', this.pane, 'C-u']);
    await this.tmux(['send-keys', '-t', this.pane, '-l', command]);
    await this.tmux(['send-keys', '-t', this.pane, 'Enter']);
  }

  static async run(args: string[]): Promise<void> {
    const proc = Bun.spawn(['tmux', ...args], { stdout: 'ignore', stderr: 'pipe' });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      throw new Error(`tmux ${args[0]}: ${stderr || `код ${code}`}`);
    }
  }
}
