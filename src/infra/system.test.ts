import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DetachedProcess, RandomIds, SystemClock } from './system.ts';

describe('SystemClock', () => {
  test('now — текущее время', () => {
    const before = Date.now();
    const now = new SystemClock().now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  test('sleep ждёт и отменяется сигналом', async () => {
    const clock = new SystemClock();
    const start = Date.now();
    await clock.sleep(20, new AbortController().signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);

    const ac = new AbortController();
    const long = clock.sleep(10_000, ac.signal);
    ac.abort();
    await long;
    expect(Date.now() - start).toBeLessThan(1000);

    await clock.sleep(10_000, ac.signal);
  });
});

describe('RandomIds', () => {
  test('префикс и уникальность; короткий id для callback_data', () => {
    const ids = new RandomIds();
    const seen = new Set(Array.from({ length: 1000 }, () => ids.next('q')));
    expect(seen.size).toBe(1000);
    for (const id of seen) expect(id).toMatch(/^q_[0-9a-z]{10}$/);
  });
});

describe('DetachedProcess', () => {
  test('запускает фоном и не ждёт его конца; вывод — в лог (каталог создаётся)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herald-detach-'));
    try {
      const log = join(dir, 'self', '20.log');
      const start = Date.now();
      await DetachedProcess.spawn(['sh', '-c', 'sleep 0.3; echo готово'], log);
      expect(Date.now() - start).toBeLessThan(250);
      for (let i = 0; i < 40 && !readFileSync(log, 'utf8').includes('готово'); i++) await Bun.sleep(50);
      expect(readFileSync(log, 'utf8')).toContain('готово');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
