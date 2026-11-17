import { describe, expect, test } from 'bun:test';
import { DomainError } from './errors.ts';
import { NewWindowDialog } from './new-window.ts';

const t0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const base = { chatId: 7, person: 'nur' };
const laptop = { name: 'laptop', dirs: ['/home/nur/dev/herald', '/home/nur/dev/u7'] };
const pc = { name: 'pc', dirs: [] };

describe('NewWindowDialog', () => {
  test('несколько машин: шаг машины → кнопка → каталоги машины → кнопка → задача', () => {
    const d = NewWindowDialog.start({ ...base, hosts: [laptop, pc] }, t0);
    expect(d.step).toBe('host');
    expect(d.choices).toEqual(['laptop', 'pc']);
    d.choose('host', 0);
    expect(d.step).toBe('dir');
    expect(d.host).toBe('laptop');
    expect(d.choices).toEqual(laptop.dirs);
    d.choose('dir', 1);
    expect(d.step).toBe('prompt');
    expect(d.dir).toBe('/home/nur/dev/u7');
    expect(d.choices).toEqual([]);
    expect(d.input(' сделай\nэто ')).toEqual({ host: 'laptop', dir: '/home/nur/dev/u7', prompt: 'сделай\nэто' });
  });

  test('одна машина — шаг машины пропускается; каталог — вводом', () => {
    const d = NewWindowDialog.start({ ...base, hosts: [laptop] }, t0);
    expect(d.step).toBe('dir');
    expect(d.host).toBe('laptop');
    expect(d.input(' ~/dev/x ')).toBeUndefined();
    expect(d.step).toBe('prompt');
    expect(d.dir).toBe('~/dev/x');
  });

  test('машину можно написать именем из предложенных', () => {
    const d = NewWindowDialog.start({ ...base, hosts: [laptop, pc] }, t0);
    expect(d.input(' pc ')).toBeUndefined();
    expect(d.host).toBe('pc');
    expect(() => NewWindowDialog.start({ ...base, hosts: [laptop, pc] }, t0).input('srv')).toThrow(DomainError);
  });

  test('нет машин — ошибка; каталогов — не больше MAX_DIRS', () => {
    expect(() => NewWindowDialog.start({ ...base, hosts: [] }, t0)).toThrow(DomainError);
    const many = Array.from({ length: 12 }, (_, i) => `/d${i}`);
    const d = NewWindowDialog.start({ ...base, hosts: [{ name: 'h', dirs: many }] }, t0);
    expect(d.choices).toEqual(many.slice(0, NewWindowDialog.MAX_DIRS));
  });

  test('кнопка другого шага или вне списка — ошибка; пустой ввод — ошибка', () => {
    const d = NewWindowDialog.start({ ...base, hosts: [laptop, pc] }, t0);
    expect(() => d.choose('dir', 0)).toThrow(DomainError);
    expect(() => d.choose('host', 2)).toThrow(DomainError);
    expect(() => d.input('  ')).toThrow(DomainError);
    d.choose('host', 1);
    expect(() => d.choose('dir', 0)).toThrow(DomainError);
    expect(() => d.input(' ')).toThrow(DomainError);
  });

  test('устаревает через TTL; состояние восстанавливается; метка диалога — для кнопок', () => {
    const d = NewWindowDialog.start({ ...base, hosts: [laptop, pc] }, t0);
    expect(d.isExpired(t0 + NewWindowDialog.TTL_MS)).toBe(false);
    expect(d.isExpired(t0 + NewWindowDialog.TTL_MS + 1)).toBe(true);
    d.choose('host', 0);
    const r = NewWindowDialog.restore(d.toState());
    expect(r.toState()).toEqual(d.toState());
    expect(r.chatId).toBe(7);
    expect(r.person).toBe('nur');
    expect(r.token).toBe(t0.toString(36));
  });
});
