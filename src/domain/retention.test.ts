import { describe, expect, test } from 'bun:test';
import { DomainError } from './errors.ts';
import { Retention } from './retention.ts';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 17, 3, 30, 0);

describe('Retention', () => {
  test('срок по умолчанию — 14 дней; граница — now минус срок', () => {
    const r = Retention.DEFAULT;
    expect(r.days).toBe(14);
    expect(r.cutoff(now)).toBe(now - 14 * DAY);
  });

  test('свой срок в днях', () => {
    expect(Retention.ofDays(1).cutoff(now)).toBe(now - DAY);
    expect(Retention.ofDays(30).days).toBe(30);
  });

  test('срок — целое ≥ 1', () => {
    for (const days of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => Retention.ofDays(days)).toThrow(DomainError);
    }
  });
});
