import { describe, expect, test } from 'bun:test';
import { BadRequestError, RequestBody } from './body.ts';

const read = (body: string) => RequestBody.read(new Request('http://x/', { method: 'POST', body }));

describe('RequestBody', () => {
  test('не JSON и не объект — BadRequestError', async () => {
    await expect(read('{')).rejects.toBeInstanceOf(BadRequestError);
    await expect(read('[1]')).rejects.toThrow('не JSON-объект');
    await expect(read('null')).rejects.toThrow('не JSON-объект');
  });

  test('строки: обязательная, необязательная', async () => {
    const b = await read(JSON.stringify({ text: 'x', n: 1 }));
    expect(b.string('text')).toBe('x');
    expect(b.optionalString('reason')).toBeUndefined();
    expect(() => b.string('n')).toThrow('«n»');
    expect(() => b.optionalString('n')).toThrow(BadRequestError);
  });

  test('boolean: только true/false', async () => {
    const b = await read(JSON.stringify({ ok: false, n: 1 }));
    expect(b.boolean('ok')).toBe(false);
    expect((await read('{"ok":true}')).boolean('ok')).toBe(true);
    expect(() => b.boolean('n')).toThrow('«n»');
    expect(() => b.boolean('нет')).toThrow(BadRequestError);
  });

  test('waitMs: нет — 0; только целое ≥ 0', async () => {
    expect((await read('{}')).waitMs()).toBe(0);
    expect((await read('{"waitMs":1500}')).waitMs()).toBe(1500);
    for (const bad of ['-1', '1.5', '"10"']) {
      expect(async () => (await read(`{"waitMs":${bad}}`)).waitMs()).toThrow(BadRequestError);
    }
  });

  test('strings и options', async () => {
    const b = await read(JSON.stringify({ ids: ['a', 'b'], options: [{ id: 'A', text: 'SQLite', extra: 1 }] }));
    expect(b.strings('ids')).toEqual(['a', 'b']);
    expect(b.options()).toEqual([{ id: 'A', text: 'SQLite' }]);
    expect((await read('{}')).options()).toEqual([]);
    expect(() => b.strings('options')).toThrow(BadRequestError);
    expect(async () => (await read('{"options":[{"id":"A"}]}')).options()).toThrow('{ id, text }');
  });

  test('session: host и root обязательны, name — по желанию', async () => {
    const b = await read(JSON.stringify({ session: { host: 'h', root: '/r', name: 'ночь' } }));
    expect(b.session()).toEqual({ host: 'h', root: '/r', name: 'ночь' });
    expect((await read('{"session":{"host":"h","root":"/r"}}')).session()).toEqual({ host: 'h', root: '/r' });
    expect(async () => (await read('{"session":{"host":"h"}}')).session()).toThrow('«root»');
    expect(async () => (await read('{}')).session()).toThrow('«session»');
  });
});
