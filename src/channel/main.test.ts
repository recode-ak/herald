import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAIN = join(import.meta.dir, 'main.ts');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('src/channel/main.ts', () => {
  test('нет настроек — код 1, причина в stderr (stdout — только MCP)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'herald-ch-main-'));
    dirs.push(home);
    const proc = Bun.spawn(['bun', MAIN], {
      cwd: home,
      env: { PATH: process.env.PATH ?? '', HOME: home },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain('serverUrl');
    expect(await new Response(proc.stdout).text()).toBe('');
  });

  test.each(['SIGHUP', 'SIGTERM'] as const)(
    '%s (закрыли панель tmux, остановили процесс) — bye и код 0',
    async (signal) => {
      const home = mkdtempSync(join(tmpdir(), 'herald-ch-main-'));
      dirs.push(home);
      const paths: string[] = [];
      let seen: () => void = () => undefined;
      const contacted = new Promise<void>((resolve) => {
        seen = resolve;
      });
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: async (req) => {
          paths.push(new URL(req.url).pathname);
          seen();
          return Response.json({ items: [] });
        },
      });
      try {
        const proc = Bun.spawn(['bun', MAIN], {
          cwd: home,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            HERALD_URL: `http://127.0.0.1:${server.port}`,
            HERALD_TOKEN: 't',
            HERALD_HOST: 'laptop',
            HERALD_CHANNEL_EVENTS: '1',
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await contacted;
        proc.kill(signal);
        expect(await proc.exited).toBe(0);
        expect(paths).toContain('/v1/bye');
      } finally {
        server.stop(true);
      }
    },
  );
});
