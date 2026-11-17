import { describe, expect, test } from 'bun:test';
import { DomainError } from '../domain/errors.ts';
import { Host, Launch } from '../domain/host.ts';
import { HostService } from './host.ts';
import { ForbiddenError, NotFoundError } from './ports.ts';
import { TelegramError } from './telegram.ts';
import { ann, NUR_CHAT, nur, testkit } from './testkit.fake.ts';
import { Waiter } from './waiter.ts';

function setup() {
  const kit = testkit();
  return { ...kit, host: new HostService(kit) };
}

type Kit = ReturnType<typeof setup>;

function addLaunch(kit: Kit, id: string, over: { person?: string; host?: string; messageId?: number } = {}): Launch {
  const launch = Launch.create(
    {
      id,
      person: over.person ?? 'nur',
      host: over.host ?? 'laptop',
      dir: 'dev/u7-school',
      prompt: 'Сделай задачу',
      chatId: NUR_CHAT,
      messageId: over.messageId ?? 42,
    },
    kit.clock.now(),
  );
  kit.store.saveLaunch(launch);
  return launch;
}

describe('HostService.poll', () => {
  test('отмечает машину: первая — новая, повтор — свежий lastSeenAt', async () => {
    const kit = setup();
    await kit.host.poll(nur, 0);
    expect(kit.store.host('nur', 'laptop')?.lastSeenAt).toBe(kit.clock.now());

    kit.clock.advance(5_000);
    await kit.host.poll(nur, 0);
    expect(kit.store.host('nur', 'laptop')?.lastSeenAt).toBe(kit.clock.now());
    expect(kit.store.hostsOf('nur')).toHaveLength(1);
  });

  test('невыданные запуски машины выдаются один раз — по времени создания', async () => {
    const kit = setup();
    addLaunch(kit, 'l_1');
    kit.clock.advance(1);
    addLaunch(kit, 'l_2');
    addLaunch(kit, 'l_x', { host: 'pc' });

    const got = await kit.host.poll(nur, 0);
    expect(got.map((l) => l.id)).toEqual(['l_1', 'l_2']);
    expect(kit.store.launch('l_1')?.takenAt).toBe(kit.clock.now());
    expect(await kit.host.poll(nur, 0)).toEqual([]);
    expect(kit.store.launch('l_x')?.isPending).toBe(true);
  });

  test('запуски другого человека на машине с тем же именем не выдаются', async () => {
    const kit = setup();
    addLaunch(kit, 'l_1', { person: 'ann' });
    expect(await kit.host.poll(nur, 0)).toEqual([]);
  });

  test('пусто — ждёт первого запуска до waitMs', async () => {
    const kit = setup();
    const polling = kit.host.poll(nur, 50_000);
    await Bun.sleep(0);
    expect(kit.waiter.waiting(Waiter.hostTopic('nur', 'laptop'))).toBe(1);

    addLaunch(kit, 'l_1');
    kit.waiter.notify(Waiter.hostTopic('nur', 'laptop'));
    expect((await polling).map((l) => l.id)).toEqual(['l_1']);
  });

  test('по таймауту — пусто', async () => {
    const kit = setup();
    const polling = kit.host.poll(nur, 50_000);
    await Bun.sleep(0);
    kit.clock.advance(50_000);
    expect(await polling).toEqual([]);
  });

  test('ожидание отмечает машину и в конце: она на связи весь опрос', async () => {
    const kit = setup();
    const polling = kit.host.poll(nur, 50_000);
    await Bun.sleep(0);
    kit.clock.advance(50_000);
    await polling;
    expect(kit.store.host('nur', 'laptop')?.lastSeenAt).toBe(kit.clock.now());
  });

  test('пустое имя машины — DomainError', async () => {
    const kit = setup();
    await expect(kit.host.poll({ ...nur, session: { ...nur.session, host: ' ' } }, 0)).rejects.toBeInstanceOf(
      DomainError,
    );
  });
});

describe('HostService.done', () => {
  async function taken(kit: Kit, id = 'l_1'): Promise<void> {
    addLaunch(kit, id);
    await kit.host.poll(nur, 0);
  }

  test('окно открыто — итог сохранён, человеку reply на сообщение с задачей', async () => {
    const kit = setup();
    await taken(kit);
    kit.clock.advance(3_000);
    await kit.host.done(nur, 'l_1', { ok: true, text: 'agents:3 · ~/dev/u7-school' });

    const launch = kit.store.launch('l_1')!;
    expect(launch.outcome).toEqual({ ok: true, text: 'agents:3 · ~/dev/u7-school' });
    expect(launch.finishedAt).toBe(kit.clock.now());
    const msg = kit.telegram.last(NUR_CHAT)!;
    expect(msg.replyTo).toBe(42);
    expect(msg.text).toBe('🪟 Окно открыто на laptop: agents:3 · ~/dev/u7-school');
  });

  test('окно не открылось — «⚠️ …» с текстом ошибки (хвост экрана)', async () => {
    const kit = setup();
    await taken(kit);
    await kit.host.done(nur, 'l_1', { ok: false, text: 'агент не ответил за 60 с\n> экран' });
    expect(kit.telegram.last(NUR_CHAT)?.text).toBe('⚠️ Окно не открылось на laptop: агент не ответил за 60 с\n> экран');
  });

  test('отмечает машину', async () => {
    const kit = setup();
    await taken(kit);
    kit.clock.advance(7_000);
    await kit.host.done(nur, 'l_1', { ok: true, text: 'ok' });
    expect(kit.store.host('nur', 'laptop')?.lastSeenAt).toBe(kit.clock.now());
  });

  test('повтор итога — DomainError, второго сообщения нет', async () => {
    const kit = setup();
    await taken(kit);
    await kit.host.done(nur, 'l_1', { ok: true, text: 'ok' });
    await expect(kit.host.done(nur, 'l_1', { ok: true, text: 'ok' })).rejects.toBeInstanceOf(DomainError);
    expect(kit.telegram.sentTo(NUR_CHAT)).toHaveLength(1);
  });

  test('нет запуска — NotFoundError', async () => {
    const kit = setup();
    await expect(kit.host.done(nur, 'l_9', { ok: true, text: 'ok' })).rejects.toBeInstanceOf(NotFoundError);
  });

  test('запуск другого человека — ForbiddenError', async () => {
    const kit = setup();
    await taken(kit);
    await expect(
      kit.host.done({ ...ann, session: { ...ann.session, host: 'laptop' } }, 'l_1', { ok: true, text: 'ok' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(kit.store.launch('l_1')?.outcome).toBeUndefined();
  });

  test('запуск другой машины того же человека — ForbiddenError', async () => {
    const kit = setup();
    await taken(kit);
    await expect(
      kit.host.done({ ...nur, session: { ...nur.session, host: 'pc' } }, 'l_1', { ok: true, text: 'ok' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('сбой Telegram — ошибка, но итог сохранён: повтор не откроет окно и не продублирует', async () => {
    const kit = setup();
    await taken(kit);
    kit.telegram.failNext();
    await expect(kit.host.done(nur, 'l_1', { ok: true, text: 'ok' })).rejects.toBeInstanceOf(TelegramError);
    expect(kit.store.launch('l_1')?.outcome).toEqual({ ok: true, text: 'ok' });
  });
});

test('Host на связи после опроса', async () => {
  const kit = setup();
  await kit.host.poll(nur, 0);
  kit.clock.advance(Host.ONLINE_MS);
  expect(kit.store.host('nur', 'laptop')?.isOnline(kit.clock.now())).toBe(true);
});
