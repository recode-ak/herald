import { afterEach, describe, expect, test } from 'bun:test';
import { FakeHerald } from '../channel/herald.fake.ts';
import type { InboxItemWire } from '../http/wire.ts';
import { type PiAgent, PiBridge } from './bridge.ts';

/** Агент pi в памяти: что ему сказали и какие команды дали. */
class FakeAgent implements PiAgent {
  readonly said: string[] = [];
  readonly ran: string[] = [];
  failure: string | undefined;

  async say(text: string): Promise<void> {
    this.said.push(text);
  }

  async run(command: string): Promise<void> {
    if (this.failure !== undefined) throw new Error(this.failure);
    this.ran.push(command);
  }
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function setup() {
  const herald = new FakeHerald();
  const agent = new FakeAgent();
  const logs: string[] = [];
  const bridge = new PiBridge({ herald, agent, log: (m) => logs.push(m), retryDelayMs: 5 });
  cleanup.push(() => bridge.stop({ bye: false }));
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(5);
    expect(cond()).toBe(true);
  };
  return { herald, agent, bridge, logs, until };
}

const item = (over: Partial<InboxItemWire> & Pick<InboxItemWire, 'id' | 'kind' | 'text'>): InboxItemWire => ({
  createdAt: 0,
  ...over,
});

describe('PiBridge — входящие', () => {
  test('берёт указания, поздние ответы и команды; ответы оставляет herald ask', async () => {
    const { herald, bridge, until } = setup();
    bridge.start();
    await until(() => herald.polls > 0);
    expect(herald.lastKinds).toEqual(['directive', 'late-answer', 'command']);
  });

  test('указание и поздний ответ → сообщение агенту от человека; затем подтверждение прочтения', async () => {
    const { herald, agent, bridge, until } = setup();
    bridge.start();
    herald.push(
      item({ id: 'i1', kind: 'directive', text: 'Займись тестами' }),
      item({ id: 'i2', kind: 'late-answer', text: 'B: Postgres', questionId: 'q_1', option: 'B' }),
    );
    await until(() => herald.acked.length === 2);
    expect(agent.said).toEqual([
      'Указание человека из Telegram (herald): Займись тестами\n\nЧеловек читает Telegram, а не терминал: ответ ему — `herald notify`.',
      'Переигрывание вопроса q_1 (herald): человек ответил «B: Postgres» уже после твоего решения по таймауту. Реши, нужно ли переделать.',
    ]);
    expect(herald.acked).toEqual(['i1', 'i2']);
  });

  test('команда → агенту командой, не сообщением; прочтение подтверждается', async () => {
    const { herald, agent, bridge, until } = setup();
    bridge.start();
    herald.push(item({ id: 'i1', kind: 'command', text: '/compact' }));
    await until(() => herald.acked.length === 1);
    expect(agent.ran).toEqual(['/compact']);
    expect(agent.said).toEqual([]);
  });

  test('команда не выполнена — человеку уведомление; прочтение подтверждается', async () => {
    const { herald, agent, bridge, until } = setup();
    agent.failure = 'сессия занята';
    bridge.start();
    herald.push(item({ id: 'i1', kind: 'command', text: '/clear' }));
    await until(() => herald.acked.length === 1);
    expect(herald.notified).toEqual(['⚠️ /clear не выполнена: сессия занята']);
  });

  test('сбой команды позже (в pi) — то же уведомление', async () => {
    const { herald, bridge } = setup();
    await bridge.failed('/compact', new Error('Nothing to compact'));
    expect(herald.notified).toEqual(['⚠️ /compact не выполнена: Nothing to compact']);
  });

  test('сбой сервера — в лог один раз за серию, пауза, цикл продолжается', async () => {
    const { herald, agent, bridge, logs, until } = setup();
    herald.failNext('сеть');
    bridge.start();
    await until(() => logs.length === 1);
    herald.push(item({ id: 'i1', kind: 'directive', text: 'x' }));
    await until(() => agent.said.length === 1);
    expect(logs).toEqual(['herald: входящие недоступны — сеть']);
    herald.failNext('снова');
    await until(() => logs.length === 2);
  });
});

describe('PiBridge — закрытие', () => {
  test('stop с bye — herald узнаёт, что окно закрыто; цикл остановлен', async () => {
    const { herald, bridge, until } = setup();
    bridge.start();
    await until(() => herald.polls > 0);
    await bridge.stop({ bye: true });
    const polls = herald.polls;
    await Bun.sleep(40);
    expect(herald.byes).toBe(1);
    expect(herald.polls).toBeLessThanOrEqual(polls + 1);
  });

  test('stop без bye (reload) — окно не закрывается; повторный stop — то же закрытие', async () => {
    const { herald, bridge } = setup();
    bridge.start();
    await Promise.all([bridge.stop({ bye: false }), bridge.stop({ bye: true })]);
    expect(herald.byes).toBe(0);
  });

  test('stop во время доставки — сначала подтверждение прочтения, потом bye', async () => {
    const { herald, agent, bridge, until } = setup();
    let release = () => {};
    agent.run = async (command) => {
      agent.ran.push(command);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    bridge.start();
    herald.push(item({ id: 'i1', kind: 'command', text: '/clear' }));
    await until(() => agent.ran.length === 1);
    const stopping = bridge.stop({ bye: true });
    release();
    await stopping;
    expect(herald.calls).toEqual(['ack', 'bye']);
  });

  test('сбой bye — в лог, закрытие не падает', async () => {
    const { herald, bridge, logs } = setup();
    herald.failNext('сеть');
    await bridge.stop({ bye: true });
    expect(logs).toEqual(['herald: bye — сеть']);
  });
});
