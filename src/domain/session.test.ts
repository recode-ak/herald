import { describe, expect, test } from 'bun:test';
import { DomainError } from './errors.ts';
import { Session } from './session.ts';

const HOUR = 3_600_000;
const t0 = Date.UTC(2026, 10, 16, 12, 0, 0);

describe('Session', () => {
  test('ключ — host + корень git, проект — имя корня', () => {
    const s = Session.open({ person: 'nur', host: 'laptop', root: '/home/nur/dev/kalki/u7-school' }, t0);
    expect(s.key).toBe('laptop:/home/nur/dev/kalki/u7-school');
    expect(s.project).toBe('u7-school');
    expect(s.person).toBe('nur');
    expect(s.lastSeenAt).toBe(t0);
    expect(s.status).toBeUndefined();
  });

  test('явное имя сессии вместо корня', () => {
    const s = Session.open({ person: 'nur', host: 'laptop', root: '/home/nur/x', name: 'ревью' }, t0);
    expect(s.key).toBe('laptop:@ревью');
    expect(s.project).toBe('ревью');
  });

  test('ключ без открытия сессии совпадает с ключом открытой', () => {
    const ref = { host: 'srv', root: '/srv/app/' };
    expect(Session.keyOf(ref)).toBe(Session.open({ person: 'nur', ...ref }, t0).key);
    expect(Session.keyOf(ref)).toBe('srv:/srv/app');
  });

  test('пустые host или root — ошибка', () => {
    expect(() => Session.open({ person: 'nur', host: ' ', root: '/x' }, t0)).toThrow(DomainError);
    expect(() => Session.open({ person: 'nur', host: 'h', root: '' }, t0)).toThrow(DomainError);
  });

  test('обращение обновляет активность', () => {
    const s = Session.open({ person: 'nur', host: 'h', root: '/x' }, t0);
    s.touch(t0 + HOUR);
    expect(s.lastSeenAt).toBe(t0 + HOUR);
  });

  test('статус — текст и время, он же обращение', () => {
    const s = Session.open({ person: 'nur', host: 'h', root: '/x' }, t0);
    s.setStatus('  Ф1 · задача 2/7  ', t0 + 5);
    expect(s.status).toEqual({ text: 'Ф1 · задача 2/7', at: t0 + 5 });
    expect(s.lastSeenAt).toBe(t0 + 5);
  });

  test('пустой или слишком длинный статус — ошибка', () => {
    const s = Session.open({ person: 'nur', host: 'h', root: '/x' }, t0);
    expect(() => s.setStatus('  ', t0)).toThrow(DomainError);
    expect(() => s.setStatus('x'.repeat(Session.STATUS_MAX + 1), t0)).toThrow(DomainError);
  });

  test('активна в пределах окна от последнего обращения', () => {
    const s = Session.open({ person: 'nur', host: 'h', root: '/x' }, t0);
    expect(s.isActive(t0 + 12 * HOUR, 12 * HOUR)).toBe(true);
    expect(s.isActive(t0 + 12 * HOUR + 1, 12 * HOUR)).toBe(false);
  });

  test('состояние сохраняется и восстанавливается', () => {
    const s = Session.open({ person: 'nur', host: 'h', root: '/x' }, t0);
    s.setStatus('идёт', t0 + 1);
    const back = Session.restore(s.toState());
    expect(back.toState()).toEqual(s.toState());
  });
});
