import { Access } from '../domain/access.ts';
import { SqliteStore } from '../infra/sqlite-store.ts';
import type { Clock, Ids } from './ports.ts';
import { FakeTelegram } from './telegram.fake.ts';
import { Waiter } from './waiter.ts';

/** Часы, которые двигает тест: `advance` будит тех, чей срок настал. */
export class ManualClock implements Clock {
  private readonly sleeping = new Set<{ until: number; wake: () => void }>();

  constructor(private t = 1_000_000) {}

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const sleeper = {
        until: this.t + ms,
        wake: () => {
          this.sleeping.delete(sleeper);
          resolve();
        },
      };
      if (signal.aborted) return resolve();
      this.sleeping.add(sleeper);
      signal.addEventListener('abort', sleeper.wake, { once: true });
    });
  }

  advance(ms: number): void {
    this.t += ms;
    for (const sleeper of [...this.sleeping]) if (sleeper.until <= this.t) sleeper.wake();
  }

  /** Сколько снов ещё не завершилось. */
  get sleepers(): number {
    return this.sleeping.size;
  }
}

/** Предсказуемые id: `q_1`, `q_2`, `i_1`… */
export class SeqIds implements Ids {
  private readonly counters = new Map<string, number>();
  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${n}`;
  }
}

export const NUR_CHAT = 111;
export const ANN_CHAT = 222;

/** Общий набор для тестов сценариев: SQLite в памяти, фейковый Telegram, два человека. */
export function testkit() {
  const clock = new ManualClock();
  return {
    store: SqliteStore.open(':memory:'),
    telegram: new FakeTelegram(),
    access: Access.parse('nur:t-nur,ann:t-ann', `nur:${NUR_CHAT},ann:${ANN_CHAT}`),
    clock,
    ids: new SeqIds(),
    waiter: new Waiter(clock),
    timeZone: 'Asia/Oral',
  };
}

export const nur = { person: 'nur', session: { host: 'laptop', root: '/home/nur/dev/u7-school' } };
export const ann = { person: 'ann', session: { host: 'pc', root: '/home/ann/site' } };
