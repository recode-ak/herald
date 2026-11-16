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
});
