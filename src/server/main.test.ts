import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBotApi } from '../infra/bot-api.fake.ts';

const main = join(import.meta.dir, 'main.ts');
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Окружение процесса без унаследованных HERALD_*. */
function baseEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => !e[0].startsWith('HERALD_') && e[1] !== undefined),
  );
}

describe('src/server/main.ts', () => {
  test('нет обязательной переменной — код 1 и понятное сообщение', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herald-main-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const proc = Bun.spawn(['bun', main], { cwd: dir, env: baseEnv(), stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain('HERALD_TOKENS не задана');
  });

  test('старт из окружения, SIGTERM — корректная остановка, код 0', async () => {
    const fake = new FakeBotApi();
    const dir = mkdtempSync(join(tmpdir(), 'herald-main-'));
    cleanup.push(
      () => fake.stop(),
      () => rmSync(dir, { recursive: true, force: true }),
    );
    const proc = Bun.spawn(['bun', main], {
      cwd: dir,
      env: {
        ...baseEnv(),
        HERALD_TOKENS: 'nur:t-nur',
        HERALD_PEOPLE: 'nur:111',
        HERALD_BOT_TOKEN: fake.token,
        HERALD_TELEGRAM_API: fake.baseUrl,
        HERALD_PORT: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    cleanup.push(() => proc.kill('SIGKILL'));

    const reader = proc.stdout.getReader();
    let out = '';
    while (!/слушает (\S+)/.test(out)) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    const url = out.match(/слушает (\S+)/)?.[1];
    expect(url).toBeString();
    expect(await (await fetch(new URL('/health', url))).json()).toEqual({ ok: true });

    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
    expect(await Bun.file(join(dir, 'data', 'herald.db')).exists()).toBe(true);
  });
});
