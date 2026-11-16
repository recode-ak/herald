import { describe, expect, test } from 'bun:test';
import { RandomIds, SystemClock } from './system.ts';

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
