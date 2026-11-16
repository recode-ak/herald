import { describe, expect, test } from 'bun:test';
import { Args, UsageError } from './args.ts';

const spec = { values: ['timeout', 'session', 'recommended'], lists: ['o'], switches: ['ack'] };

describe('Args', () => {
  test('позиционные, значения (--x v и --x=v), повторяемые -o, переключатели', () => {
    const a = Args.parse(
      ['Какую', '-o', 'A: SQLite', '--timeout=180', '-o', 'B: PG', '--ack', 'БД?', '--session', 'н'],
      spec,
    );
    expect(a.positional).toEqual(['Какую', 'БД?']);
    expect(a.value('timeout')).toBe('180');
    expect(a.value('session')).toBe('н');
    expect(a.list('o')).toEqual(['A: SQLite', 'B: PG']);
    expect(a.has('ack')).toBe(true);
    expect(a.value('recommended')).toBeUndefined();
  });

  test('после -- всё позиционное', () => {
    expect(Args.parse(['--', '--timeout', '-o'], spec).positional).toEqual(['--timeout', '-o']);
  });

  test('неизвестный флаг, флаг без значения, значение у переключателя — UsageError', () => {
    expect(() => Args.parse(['--nope'], spec)).toThrow(UsageError);
    expect(() => Args.parse(['--timeout'], spec)).toThrow('--timeout');
    expect(() => Args.parse(['--ack=1'], spec)).toThrow('--ack');
  });

  test('seconds: целое ≥ 0 → мс; иначе UsageError', () => {
    expect(Args.parse(['--timeout', '3'], spec).seconds('timeout')).toBe(3000);
    expect(Args.parse([], spec).seconds('timeout')).toBeUndefined();
    expect(() => Args.parse(['--timeout', '-1'], spec).seconds('timeout')).toThrow(UsageError);
    expect(() => Args.parse(['--timeout', 'x'], spec).seconds('timeout')).toThrow(UsageError);
  });
});
