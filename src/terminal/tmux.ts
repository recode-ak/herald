import type { Terminal } from './terminal.ts';

type Env = Record<string, string | undefined>;
/** Запуск `tmux` с аргументами; ненулевой код — исключение. */
type TmuxRun = (args: string[]) => Promise<void>;

/**
 * Терминал окна агента в tmux: текст набирается в панель так, будто его ввёл человек.
 * Поле ввода сначала очищается (Ctrl+U; набранное возвращает Ctrl+Y), иначе текст приклеится к черновику.
 * Многострочный — вставкой (bracketed paste): перевод строки, набранный клавишей, отправил бы сообщение по частям.
 * Если агент занят, Claude Code ставит команду в очередь и выполняет после хода.
 */
export class TmuxTerminal implements Terminal {
  constructor(
    readonly pane: string,
    private readonly tmux: TmuxRun = TmuxTerminal.run,
  ) {}

  /** Панель процесса из `TMUX_PANE` (наследуется от Claude Code); вне tmux — `undefined`. */
  static fromEnv(env: Env): TmuxTerminal | undefined {
    const pane = env.TMUX_PANE?.trim();
    return pane ? new TmuxTerminal(pane) : undefined;
  }

  async send(text: string): Promise<void> {
    await this.tmux(['send-keys', '-t', this.pane, 'C-u']);
    if (text.includes('\n')) {
      // Буфер — свой у панели; -d удаляет его после вставки.
      const buffer = `herald-${this.pane}`;
      await this.tmux(['set-buffer', '-b', buffer, '--', text]);
      await this.tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', this.pane]);
    } else {
      await this.tmux(['send-keys', '-t', this.pane, '-l', text]);
    }
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
