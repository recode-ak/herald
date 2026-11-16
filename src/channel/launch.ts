/** Как запущен Claude Code — родитель процесса канала. */
export interface Launch {
  /** Claude Code принимает события канала (`notifications/claude/channel`) от этого сервера. */
  events: boolean;
  /** Разовый запуск `claude -p`. */
  print: boolean;
}

/** Откуда брать аргументы процесса (в тестах — подмена). */
export interface ProcessArgs {
  readFile(path: string): Promise<string>;
  /** Строка аргументов процесса из `ps -o args=`. */
  ps(pid: number): Promise<string>;
}

type Env = Record<string, string | undefined>;

/**
 * Запуск Claude Code по его аргументам. Изнутри MCP этого не узнать: рукопожатие с флагом канала и без
 * одинаковое, а события без флага Claude Code молча отбрасывает.
 *
 * Свой (не маркетплейсный) сервер Claude Code слушает только с `--dangerously-load-development-channels server:<имя>`;
 * `--channels server:<имя>` он отбрасывает — сервера нет в списке одобренных.
 */
export class ClaudeLaunch {
  static readonly DEV_FLAG = '--dangerously-load-development-channels';

  /** `server` — имя MCP-сервера herald в настройках Claude Code. */
  constructor(
    private readonly server: string = 'herald',
    private readonly args: ProcessArgs = ClaudeLaunch.system,
  ) {}

  parse(argv: readonly string[]): Launch {
    const wanted = `server:${this.server}`;
    const flag = ClaudeLaunch.DEV_FLAG;
    let events = false;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i] as string;
      const values: string[] = [];
      if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
      else if (arg === flag)
        for (let j = i + 1; j < argv.length && !(argv[j] as string).startsWith('-'); j++)
          values.push(argv[j] as string);
      if (values.some((v) => v.split(',').includes(wanted))) events = true;
    }
    return { events, print: argv.includes('-p') || argv.includes('--print') };
  }

  /**
   * Запуск процесса `pid` (родителя канала): `/proc/<pid>/cmdline` (Linux), иначе `ps`; не вышло — `undefined`.
   * `HERALD_CHANNEL_EVENTS=1|0` в `env` задаёт события явно, поверх аргументов.
   */
  async of(pid: number, env: Env = {}): Promise<Launch | undefined> {
    const forced = env.HERALD_CHANNEL_EVENTS?.trim();
    const launch = await this.read(pid);
    if (forced === '1' || forced === '0') return { events: forced === '1', print: launch?.print ?? false };
    return launch;
  }

  private async read(pid: number): Promise<Launch | undefined> {
    try {
      return this.parse((await this.args.readFile(`/proc/${pid}/cmdline`)).split('\0').filter(Boolean));
    } catch {
      try {
        return this.parse((await this.args.ps(pid)).trim().split(/\s+/));
      } catch {
        return undefined;
      }
    }
  }

  private static readonly system: ProcessArgs = {
    readFile: (path) => Bun.file(path).text(),
    async ps(pid) {
      const proc = Bun.spawn(['ps', '-o', 'args=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0 || !out.trim()) throw new Error(`ps: процесс ${pid} не найден`);
      return out;
    },
  };
}
