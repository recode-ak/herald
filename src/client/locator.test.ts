import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLocator } from './locator.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'herald-loc-')));
  dirs.push(dir);
  return dir;
}

describe('SessionLocator', () => {
  test('корень — корень git-репо, даже из подкаталога', () => {
    const repo = tempDir();
    Bun.spawnSync(['git', 'init', '-q', repo]);
    const sub = join(repo, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    expect(new SessionLocator('laptop').locate({ cwd: sub })).toEqual({ host: 'laptop', root: repo });
  });

  test('вне git — текущий каталог', () => {
    const dir = tempDir();
    expect(new SessionLocator('laptop').locate({ cwd: dir })).toEqual({ host: 'laptop', root: dir });
  });

  test('явное имя (--session) — в ref; пустое — как нет', () => {
    const dir = tempDir();
    const locator = new SessionLocator('laptop');
    expect(locator.locate({ cwd: dir, name: 'ночь' })).toEqual({ host: 'laptop', root: dir, name: 'ночь' });
    expect(locator.locate({ cwd: dir, name: ' ' })).toEqual({ host: 'laptop', root: dir });
  });

  test('сессия Claude Code (CLAUDE_CODE_SESSION_ID) — окно: первые 4 символа; явное имя главнее', () => {
    const dir = tempDir();
    const locator = new SessionLocator('laptop');
    const agentSession = '02dcbdb9-11eb-4ebb-a9f9-48d9cc4d2656';
    expect(locator.locate({ cwd: dir, agentSession })).toEqual({ host: 'laptop', root: dir, instance: '02dc' });
    expect(locator.locate({ cwd: dir, name: 'ночь', agentSession })).toEqual({
      host: 'laptop',
      root: dir,
      name: 'ночь',
    });
    expect(locator.locate({ cwd: dir, agentSession: ' ' })).toEqual({ host: 'laptop', root: dir });
  });

  test('окно агента (pid Claude Code) главнее id разговора: /clear меняет разговор, а не окно', () => {
    const dir = tempDir();
    const starts = new Map([[4242, 'Mon Nov 16 23:07:10 2026']]);
    const locator = new SessionLocator('laptop', { startOf: (pid) => starts.get(pid) });
    const before = locator.locate({ cwd: dir, agentProcess: 4242, agentSession: 'a8ae28ed-c329' });
    const after = locator.locate({ cwd: dir, agentProcess: 4242, agentSession: '1fea0f01-2878' });
    expect(before).toEqual(after);
    expect(before.instance).toMatch(/^[0-9a-f]{4}$/);
    expect(before.instance).toBe(SessionLocator.windowTag(4242, 'Mon Nov 16 23:07:10 2026'));
  });

  test('окно: тот же pid после перезапуска (другое время старта) — другая метка; время не узнали — по pid', () => {
    const dir = tempDir();
    let start: string | undefined = 'Mon Nov 16 23:07:10 2026';
    const locator = new SessionLocator('laptop', { startOf: () => start });
    const first = locator.locate({ cwd: dir, agentProcess: 4242 }).instance;
    start = 'Tue Nov 17 09:00:00 2026';
    expect(locator.locate({ cwd: dir, agentProcess: 4242 }).instance).not.toBe(first);
    start = undefined;
    expect(locator.locate({ cwd: dir, agentProcess: 4242 }).instance).toBe(SessionLocator.windowTag(4242));
  });

  test('системный процесс: время старта текущего процесса известно, несуществующего — нет', () => {
    expect(SessionLocator.system.startOf(process.pid)).toBeString();
    expect(SessionLocator.system.startOf(2 ** 22 + 1)).toBeUndefined();
  });

  test('явное имя главнее окна', () => {
    const dir = tempDir();
    const locator = new SessionLocator('laptop', { startOf: () => 'x' });
    expect(locator.locate({ cwd: dir, name: 'ночь', agentProcess: 4242 })).toEqual({
      host: 'laptop',
      root: dir,
      name: 'ночь',
    });
  });
});
