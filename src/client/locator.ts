import type { SessionRef } from '../domain/session.ts';

/** Где работает агент: host из настроек, корень git-репо текущего каталога (вне git — сам каталог), явное имя. */
export class SessionLocator {
  constructor(private readonly host: string) {}

  locate(options: { cwd: string; name?: string | undefined }): SessionRef {
    const root = SessionLocator.gitRoot(options.cwd) ?? options.cwd;
    const name = options.name?.trim();
    return name ? { host: this.host, root, name } : { host: this.host, root };
  }

  private static gitRoot(cwd: string): string | undefined {
    const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd, stdout: 'pipe', stderr: 'ignore' });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.toString().trim() || undefined;
  }
}
