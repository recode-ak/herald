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
});
