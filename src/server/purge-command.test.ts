import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../domain/session.ts';
import { SqliteStore } from '../infra/sqlite-store.ts';
import { ConfigError } from './config.ts';
import { PurgeCommand } from './purge-command.ts';

const DAY = 86_400_000;
const entry = join(import.meta.dir, 'purge.ts');
const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'herald-purge-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** База с одной давней и одной свежей сессией. */
function seed(path: string): void {
  const store = SqliteStore.open(path);
  store.saveSession(Session.open({ person: 'nur', host: 'laptop', root: '/old' }, Date.now() - 20 * DAY));
  store.saveSession(Session.open({ person: 'nur', host: 'laptop', root: '/new' }, Date.now() - DAY));
  store.close();
}

describe('PurgeCommand.parse', () => {
  test('по умолчанию — 14 дней, ./data/herald.db, по-настоящему', () => {
    const c = PurgeCommand.parse([], {});
    expect(c.retention.days).toBe(14);
    expect(c.dbPath).toBe('./data/herald.db');
    expect(c.dryRun).toBe(false);
  });

  test('HERALD_RETENTION_DAYS и HERALD_DB; --days важнее окружения; --dry-run', () => {
    expect(PurgeCommand.parse([], { HERALD_RETENTION_DAYS: '30', HERALD_DB: '/x.db' })).toMatchObject({
      dbPath: '/x.db',
      retention: { days: 30 },
    });
    const c = PurgeCommand.parse(['--days', '3', '--dry-run'], { HERALD_RETENTION_DAYS: '30' });
    expect(c.retention.days).toBe(3);
    expect(c.dryRun).toBe(true);
  });

  test('неверный срок, лишний аргумент — ConfigError', () => {
    expect(() => PurgeCommand.parse(['--days', '0'], {})).toThrow(ConfigError);
    expect(() => PurgeCommand.parse(['--days'], {})).toThrow(ConfigError);
    expect(() => PurgeCommand.parse([], { HERALD_RETENTION_DAYS: 'две недели' })).toThrow(ConfigError);
    expect(() => PurgeCommand.parse(['--force'], {})).toThrow('--force');
  });
});

describe('PurgeCommand.run', () => {
  test('удаляет старое и возвращает итог с границей', () => {
    const path = join(tempDir(), 'h.db');
    seed(path);
    const now = Date.now();
    const out = PurgeCommand.parse([], { HERALD_DB: path }).run(now);
    expect(out).toMatchObject({
      days: 14,
      dryRun: false,
      cutoff: new Date(now - 14 * DAY).toISOString(),
      deleted: { sessions: 1 },
      remaining: { sessions: 1 },
    });
    expect(out.dbBytes).toBeGreaterThan(0);
  });

  test('нет файла базы — ConfigError, файл не создаётся', () => {
    const path = join(tempDir(), 'нет.db');
    expect(() => PurgeCommand.parse([], { HERALD_DB: path }).run(Date.now())).toThrow(ConfigError);
    expect(Bun.file(path).size).toBe(0);
  });
});

describe('src/server/purge.ts', () => {
  test('JSON в stdout, код 0; --dry-run ничего не удаляет', async () => {
    const dir = tempDir();
    seed(join(dir, 'h.db'));
    const env = { ...process.env, HERALD_DB: join(dir, 'h.db') };

    const dry = Bun.spawn(['bun', entry, '--dry-run'], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
    expect(await dry.exited).toBe(0);
    expect(JSON.parse(await new Response(dry.stdout).text())).toMatchObject({ dryRun: true, deleted: { sessions: 1 } });

    const real = Bun.spawn(['bun', entry], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
    expect(await real.exited).toBe(0);
    expect(JSON.parse(await new Response(real.stdout).text())).toMatchObject({ deleted: { sessions: 1 } });
  });

  test('ошибка — код 1 и текст в stderr', async () => {
    const dir = tempDir();
    const proc = Bun.spawn(['bun', entry, '--days', 'x'], {
      cwd: dir,
      env: { ...process.env, HERALD_DB: join(dir, 'h.db') },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain('--days');
  });
});
