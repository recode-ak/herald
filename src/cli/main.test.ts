import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..', '..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('herald как программа', () => {
  test('bun run link ставит ~/.local/bin/herald; он запускается из любого каталога', () => {
    const home = mkdtempSync(join(tmpdir(), 'herald-home-'));
    dirs.push(home);
    const env = { ...process.env, HOME: home };
    expect(Bun.spawnSync(['bun', 'run', 'link'], { cwd: repo, env, stdout: 'pipe' }).exitCode).toBe(0);

    const help = Bun.spawnSync([join(home, '.local', 'bin', 'herald'), '--help'], { cwd: home, env, stdout: 'pipe' });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain('herald ask');
  });

  test('ошибка — код выхода 1', () => {
    const home = mkdtempSync(join(tmpdir(), 'herald-home-'));
    dirs.push(home);
    const run = Bun.spawnSync(['bun', join(repo, 'src', 'cli', 'main.ts'), 'notify', 'x'], {
      cwd: home,
      env: { PATH: process.env.PATH ?? '', HOME: home },
      stderr: 'pipe',
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain('serverUrl');
  });
});
