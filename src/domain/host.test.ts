import { describe, expect, test } from 'bun:test';
import { DomainError } from './errors.ts';
import { Host, Launch } from './host.ts';
import { Session } from './session.ts';

const t0 = Date.UTC(2026, 10, 17, 12, 0, 0);

describe('Host', () => {
  test('машина человека: имя без пробелов по краям; на связи — опрос не старше, чем у сессии', () => {
    const h = Host.seen({ person: 'nur', name: ' laptop ' }, t0);
    expect(h.person).toBe('nur');
    expect(h.name).toBe('laptop');
    expect(h.lastSeenAt).toBe(t0);
    expect(h.isOnline(t0 + Host.ONLINE_MS)).toBe(true);
    expect(h.isOnline(t0 + Host.ONLINE_MS + 1)).toBe(false);
    expect(Host.ONLINE_MS).toBe(Session.ONLINE_MS);
  });

  test('опрос отмечает машину; пустое имя — ошибка; состояние восстанавливается', () => {
    const h = Host.seen({ person: 'nur', name: 'laptop' }, t0);
    h.touch(t0 + 10);
    expect(h.lastSeenAt).toBe(t0 + 10);
    expect(() => Host.seen({ person: 'nur', name: '  ' }, t0)).toThrow(DomainError);
    expect(Host.restore(h.toState()).toState()).toEqual(h.toState());
  });
});

describe('Launch', () => {
  const draft = {
    id: 'l_1',
    person: 'nur',
    host: 'laptop',
    dir: ' dev/u7 ',
    prompt: ' сделай\nэто ',
    chatId: 7,
    messageId: 42,
  };

  test('запуск: каталог и задача без пробелов по краям, ждёт выдачи', () => {
    const l = Launch.create(draft, t0);
    expect(l.toState()).toEqual({ ...draft, dir: 'dev/u7', prompt: 'сделай\nэто', createdAt: t0 });
    expect(l.isPending).toBe(true);
    expect(() => Launch.create({ ...draft, dir: ' ' }, t0)).toThrow(DomainError);
    expect(() => Launch.create({ ...draft, prompt: ' ' }, t0)).toThrow(DomainError);
    expect(() => Launch.create({ ...draft, host: ' ' }, t0)).toThrow(DomainError);
  });

  test('выдаётся демону один раз', () => {
    const l = Launch.create(draft, t0);
    l.take(t0 + 1);
    expect(l.takenAt).toBe(t0 + 1);
    expect(l.isPending).toBe(false);
    expect(() => l.take(t0 + 2)).toThrow(DomainError);
  });

  test('итог — после выдачи и один раз; текст обязателен', () => {
    const l = Launch.create(draft, t0);
    expect(() => l.finish({ ok: true, text: 'окно' }, t0)).toThrow(DomainError);
    l.take(t0 + 1);
    expect(() => l.finish({ ok: false, text: ' ' }, t0 + 2)).toThrow(DomainError);
    l.finish({ ok: false, text: ' нет каталога ' }, t0 + 2);
    expect(l.outcome).toEqual({ ok: false, text: 'нет каталога' });
    expect(l.finishedAt).toBe(t0 + 2);
    expect(() => l.finish({ ok: true, text: 'окно' }, t0 + 3)).toThrow(DomainError);
    expect(Launch.restore(l.toState()).toState()).toEqual(l.toState());
  });
});
