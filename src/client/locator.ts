import type { SessionRef } from '../domain/session.ts';

/**
 * Где работает агент: host из настроек, корень git-репо текущего каталога (вне git — сам каталог), явное имя.
 * `agentSession` — id сессии агента (`CLAUDE_CODE_SESSION_ID`): параллельные окна в одном корне — разные сессии.
 */
export class SessionLocator {
  /** Сколько символов id сессии агента идёт в метку окна. */
  static readonly INSTANCE_LENGTH = 4;

  constructor(private readonly host: string) {}

  locate(options: { cwd: string; name?: string | undefined; agentSession?: string | undefined }): SessionRef {
    const root = SessionLocator.gitRoot(options.cwd) ?? options.cwd;
    const name = options.name?.trim();
    if (name) return { host: this.host, root, name };
    const instance = options.agentSession?.trim().slice(0, SessionLocator.INSTANCE_LENGTH);
    return instance ? { host: this.host, root, instance } : { host: this.host, root };
  }

  private static gitRoot(cwd: string): string | undefined {
    const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd, stdout: 'pipe', stderr: 'ignore' });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.toString().trim() || undefined;
  }
}
