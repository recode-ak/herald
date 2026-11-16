import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { SessionRef } from '../domain/session.ts';

/** Сведения о процессах (в тестах — подмена). */
export interface Processes {
  /** Время старта процесса строкой (`ps -o lstart=`); процесса нет — `undefined`. */
  startOf(pid: number): string | undefined;
}

/**
 * Где работает агент: host из настроек, корень git-репо текущего каталога (вне git — сам каталог), явное имя.
 * Параллельные окна в одном корне — разные сессии; метка окна (`instance`) берётся:
 * - `agentProcess` — pid окна агента (Claude Code: родитель канала, `CLAUDE_PID` в Bash). Канал и CLI одного окна
 *   получают одну метку, и `/clear` её не меняет (MCP-сервер живёт, меняется только id разговора);
 * - иначе `agentSession` — id сессии агента (`CLAUDE_CODE_SESSION_ID`, `PI_SESSION_ID`).
 * Только API Node: локатор работает и в расширении pi (Node).
 */
export class SessionLocator {
  /** Сколько символов идёт в метку окна. */
  static readonly INSTANCE_LENGTH = 4;

  static readonly system: Processes = {
    startOf(pid) {
      const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        // Канал и CLI должны получить одну строку при любой локали.
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (result.status !== 0) return undefined;
      return result.stdout.trim() || undefined;
    },
  };

  constructor(
    private readonly host: string,
    private readonly processes: Processes = SessionLocator.system,
  ) {}

  locate(options: {
    cwd: string;
    name?: string | undefined;
    agentProcess?: number | undefined;
    agentSession?: string | undefined;
  }): SessionRef {
    const root = SessionLocator.gitRoot(options.cwd) ?? options.cwd;
    const name = options.name?.trim();
    if (name) return { host: this.host, root, name };
    const pid = options.agentProcess;
    const instance =
      pid !== undefined && Number.isSafeInteger(pid) && pid > 0
        ? SessionLocator.windowTag(pid, this.processes.startOf(pid))
        : options.agentSession?.trim().slice(0, SessionLocator.INSTANCE_LENGTH);
    return instance ? { host: this.host, root, instance } : { host: this.host, root };
  }

  /** Метка окна: хэш pid и времени старта (pid после перезапуска может достаться другому окну). */
  static windowTag(pid: number, start?: string): string {
    return createHash('sha256')
      .update(start === undefined ? String(pid) : `${pid}@${start}`)
      .digest('hex')
      .slice(0, SessionLocator.INSTANCE_LENGTH);
  }

  private static gitRoot(cwd: string): string | undefined {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return undefined;
    return result.stdout.trim() || undefined;
  }
}
