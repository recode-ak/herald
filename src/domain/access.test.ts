import { describe, expect, test } from 'bun:test';
import { Access, AccessConfigError } from './access.ts';

describe('Access.parse', () => {
  test('человек по токену и chat_id, человек по chat_id', () => {
    const access = Access.parse('nur:t-laptop, nur:t-server,ann:t-ann', 'nur:111, ann:-222');
    expect(access.personByToken('t-laptop')).toBe('nur');
    expect(access.personByToken('t-server')).toBe('nur');
    expect(access.personByToken('t-ann')).toBe('ann');
    expect(access.chatIdOf('nur')).toBe(111);
    expect(access.chatIdOf('ann')).toBe(-222);
    expect(access.personByChatId(111)).toBe('nur');
    expect(access.personByChatId(-222)).toBe('ann');
  });

  test('неизвестные токен и chat_id — нет человека', () => {
    const access = Access.parse('nur:t1', 'nur:111');
    expect(access.personByToken('чужой')).toBeUndefined();
    expect(access.personByToken('')).toBeUndefined();
    expect(access.personByChatId(999)).toBeUndefined();
  });

  test('пустые строки конфига — ошибка', () => {
    expect(() => Access.parse('', 'nur:111')).toThrow(AccessConfigError);
    expect(() => Access.parse('nur:t1', ' ')).toThrow(AccessConfigError);
  });

  test('запись без двоеточия или с пустой частью — ошибка', () => {
    expect(() => Access.parse('nur', 'nur:111')).toThrow(AccessConfigError);
    expect(() => Access.parse('nur:', 'nur:111')).toThrow(AccessConfigError);
    expect(() => Access.parse(':t1', 'nur:111')).toThrow(AccessConfigError);
  });

  test('chat_id — целое число', () => {
    expect(() => Access.parse('nur:t1', 'nur:abc')).toThrow(AccessConfigError);
    expect(() => Access.parse('nur:t1', 'nur:1.5')).toThrow(AccessConfigError);
  });

  test('дубли токена и chat_id — ошибка', () => {
    expect(() => Access.parse('nur:t1,ann:t1', 'nur:111,ann:222')).toThrow(AccessConfigError);
    expect(() => Access.parse('nur:t1,ann:t2', 'nur:111,ann:111')).toThrow(AccessConfigError);
    expect(() => Access.parse('nur:t1', 'nur:111,nur:222')).toThrow(AccessConfigError);
  });

  test('человек с токеном, но без chat_id — ошибка', () => {
    expect(() => Access.parse('nur:t1,ann:t2', 'nur:111')).toThrow(AccessConfigError);
  });

  test('chatIdOf неизвестного человека — ошибка', () => {
    const access = Access.parse('nur:t1', 'nur:111');
    expect(() => access.chatIdOf('ann')).toThrow(AccessConfigError);
  });
});
