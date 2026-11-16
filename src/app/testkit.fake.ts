import { Access } from '../domain/access.ts';
import { SqliteStore } from '../infra/sqlite-store.ts';
import type { Clock, Ids } from './ports.ts';
import { FakeTelegram } from './telegram.fake.ts';

/** Часы, которые двигает тест. */
export class ManualClock implements Clock {
  constructor(private t = 1_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
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
  return {
    store: SqliteStore.open(':memory:'),
    telegram: new FakeTelegram(),
    access: Access.parse('nur:t-nur,ann:t-ann', `nur:${NUR_CHAT},ann:${ANN_CHAT}`),
    clock: new ManualClock(),
    ids: new SeqIds(),
  };
}

export const nur = { person: 'nur', session: { host: 'laptop', root: '/home/nur/dev/u7-school' } };
export const ann = { person: 'ann', session: { host: 'pc', root: '/home/ann/site' } };
