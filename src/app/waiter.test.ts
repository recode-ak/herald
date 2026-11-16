import { describe, expect, test } from 'bun:test';
import { ManualClock } from './testkit.fake.ts';
import { Waiter } from './waiter.ts';

describe('ManualClock.sleep', () => {
  test('просыпается, когда время дошло; раньше — нет', async () => {
    const clock = new ManualClock();
    let woke = false;
    const p = clock.sleep(1000, new AbortController().signal).then(() => {
      woke = true;
    });
    clock.advance(999);
    await Promise.resolve();
    expect(woke).toBe(false);
    clock.advance(1);
    await p;
    expect(woke).toBe(true);
  });

  test('отмена сигналом — сон завершается сразу', async () => {
    const clock = new ManualClock();
    const ac = new AbortController();
    const p = clock.sleep(1000, ac.signal);
    ac.abort();
    await p;
    expect(clock.sleepers).toBe(0);
  });
});

describe('Waiter', () => {
  test('событие темы будит ждущих — true', async () => {
    const clock = new ManualClock();
    const waiter = new Waiter(clock);
    const a = waiter.wait('q:1', 10_000);
    const b = waiter.wait('q:1', 10_000);
    const other = waiter.wait('q:2', 10_000);
    waiter.notify('q:1');
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(waiter.waiting('q:1')).toBe(0);
    expect(waiter.waiting('q:2')).toBe(1);
    clock.advance(10_000);
    expect(await other).toBe(false);
  });

  test('таймаут — false, подписка снимается', async () => {
    const clock = new ManualClock();
    const waiter = new Waiter(clock);
    const p = waiter.wait('s:x', 500);
    clock.advance(500);
    expect(await p).toBe(false);
    expect(waiter.waiting('s:x')).toBe(0);
  });

  test('событие без ждущих — ничего; таймер ожидания снимается при событии', async () => {
    const clock = new ManualClock();
    const waiter = new Waiter(clock);
    waiter.notify('нет');
    const p = waiter.wait('q:1', 1000);
    waiter.notify('q:1');
    await p;
    expect(clock.sleepers).toBe(0);
  });

  test('нулевой и отрицательный таймаут — сразу false', async () => {
    const waiter = new Waiter(new ManualClock());
    expect(await waiter.wait('q:1', 0)).toBe(false);
    expect(await waiter.wait('q:1', -5)).toBe(false);
  });
});
