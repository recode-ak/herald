import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('herald self уходит фоном и сразу отвечает; итог фонового процесса — в логе', async () => {
    const home = mkdtempSync(join(tmpdir(), 'herald-home-'));
    dirs.push(home);
    const run = Bun.spawnSync(
      ['bun', join(repo, 'src', 'cli', 'main.ts'), 'self', '/clear', '--delay', '0', '--message', 'Дальше'],
      { cwd: home, env: { PATH: process.env.PATH ?? '', HOME: home, TMUX_PANE: '%999999' }, stdout: 'pipe' },
    );
    expect(run.exitCode).toBe(0);
    const { log } = JSON.parse(run.stdout.toString()) as { log: string };
    const read = () => {
      try {
        return readFileSync(log, 'utf8');
      } catch {
        return '';
      }
    };
    for (let i = 0; i < 100 && !read().includes('"ok"'); i++) await Bun.sleep(50);
    // Панели нет: tmux не набрал — итог с причиной.
    expect(JSON.parse(read().trim().split('\n').at(-1) ?? '')).toEqual({
      ok: false,
      reason: expect.stringContaining('tmux'),
    });
  });

  test('herald host: сервер недоступен — ждёт; SIGTERM — код 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'herald-home-'));
    dirs.push(home);
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');
    chmodSync(join(bin, 'claude'), 0o755);
    const proc = Bun.spawn(['bun', join(repo, 'src', 'cli', 'main.ts'), 'host'], {
      cwd: home,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        HERALD_URL: 'http://127.0.0.1:1',
        HERALD_TOKEN: 't',
        HERALD_HOST: 'laptop',
      },
      stderr: 'pipe',
    });
    const reader = proc.stderr.getReader();
    let log = '';
    while (!log.includes('жду запусков')) {
      const { value, done } = await reader.read();
      if (done) break;
      log += new TextDecoder().decode(value);
    }
    expect(log).toContain('herald host: машина laptop');
    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
  });
});
