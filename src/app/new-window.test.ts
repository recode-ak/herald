import { describe, expect, test } from 'bun:test';
import { Host } from '../domain/host.ts';
import { NewWindowDialog } from '../domain/new-window.ts';
import { AgentService } from './agent.ts';
import { HostService } from './host.ts';
import { HumanService } from './human.ts';
import type { TelegramUpdate } from './telegram.ts';
import { NUR_CHAT, nur, testkit } from './testkit.fake.ts';
import { Waiter } from './waiter.ts';

function setup() {
  const kit = testkit();
  let updateId = 0;
  const human = new HumanService(kit);
  return {
    ...kit,
    agent: new AgentService(kit),
    host: new HostService(kit),
    human,
    press: (messageId: number, data: string) =>
      human.handle({
        kind: 'callback',
        updateId: ++updateId,
        callbackId: `cb${updateId}`,
        chatId: NUR_CHAT,
        messageId,
        data,
      }),
    say: (text: string, replyTo?: number) => {
      const update: TelegramUpdate = {
        kind: 'message',
        updateId: ++updateId,
        chatId: NUR_CHAT,
        messageId: 1000 + updateId,
        text,
      };
      return human.handle(replyTo === undefined ? update : { ...update, replyTo });
    },
    /** Машина на связи. */
    online: (name: string) => kit.store.saveHost(Host.seen({ person: 'nur', name }, kit.clock.now())),
    /** Сессия агента на машине (корень — каталог в кнопках). */
    session: (host: string, root: string) => new AgentService(kit).status({ ...nur, session: { host, root } }, 'x'),
  };
}

type Kit = ReturnType<typeof setup>;

const last = (k: Kit) => k.telegram.last(NUR_CHAT)!;
const data = (k: Kit) =>
  last(k)
    .buttons!.flat()
    .map((b) => b.data);
const labels = (k: Kit) =>
  last(k)
    .buttons!.flat()
    .map((b) => b.text);

describe('/new — начало', () => {
  test('машин на связи нет — подсказка, диалог не начинается', async () => {
    const k = setup();
    await k.say('/new');
    expect(last(k).text).toBe('Нет машин на связи: запусти herald host.');
    expect(k.store.dialog(NUR_CHAT)).toBeUndefined();
  });

  test('машина не на связи (старый опрос) не предлагается', async () => {
    const k = setup();
    k.online('old');
    k.clock.advance(Host.ONLINE_MS + 1);
    await k.say('/new');
    expect(last(k).text).toBe('Нет машин на связи: запусти herald host.');
  });

  test('несколько машин — кнопки машин и «Отмена»', async () => {
    const k = setup();
    k.online('laptop');
    k.clock.advance(1);
    k.online('pc');
    await k.say('/new');

    const dialog = k.store.dialog(NUR_CHAT)!;
    expect(dialog.step).toBe('host');
    expect(last(k).text).toBe('🪟 Новое окно. На какой машине?');
    expect(labels(k)).toEqual(['pc', 'laptop', '✖ Отмена']);
    expect(data(k)).toEqual([`n:${dialog.token}:h:0`, `n:${dialog.token}:h:1`, `n:${dialog.token}:x`]);
  });

  test('одна машина — сразу каталог: корни её сессий, свежие первыми, без повторов, до 8', async () => {
    const k = setup();
    k.online('laptop');
    await k.session('laptop', '/home/nur/dev/a');
    k.clock.advance(1);
    await k.session('laptop', '/home/nur/dev/b');
    await k.session('pc', '/home/nur/dev/c');
    k.clock.advance(1);
    await k.agent.status({ ...nur, session: { host: 'laptop', root: '/home/nur/dev/a', name: 'ночь' } }, 'x');
    await k.say('/new');

    const dialog = k.store.dialog(NUR_CHAT)!;
    expect(dialog.step).toBe('dir');
    expect(last(k).text).toBe('🪟 Новое окно на laptop. Каталог? Выбери или пришли путь от ~.');
    expect(labels(k)).toEqual(['~/dev/a', '~/dev/b', '✖ Отмена']);
    expect(data(k)).toEqual([`n:${dialog.token}:d:0`, `n:${dialog.token}:d:1`, `n:${dialog.token}:x`]);
  });

  test('у машины нет сессий — только ввод пути', async () => {
    const k = setup();
    k.online('laptop');
    await k.say('/new');
    expect(last(k).text).toBe('🪟 Новое окно на laptop. Пришли каталог — путь от ~.');
    expect(labels(k)).toEqual(['✖ Отмена']);
  });

  test('/new сбрасывает выбранного в /sessions адресата', async () => {
    const k = setup();
    await k.agent.notify(nur, 'x');
    await k.say('/sessions');
    await k.press(last(k).messageId, last(k).buttons![0]![0]!.data);
    expect(k.store.chatTarget(NUR_CHAT)).toBeDefined();
    k.online('laptop');
    await k.say('/new');
    expect(k.store.chatTarget(NUR_CHAT)).toBeUndefined();
  });
});

describe('/new — шаги', () => {
  async function twoHosts(k: Kit) {
    k.online('laptop');
    k.online('pc');
    await k.session('pc', '/home/nur/dev/site');
    await k.say('/new');
    return { dialog: k.store.dialog(NUR_CHAT)!, menu: last(k) };
  }

  test('кнопка машины → сообщение перерисовано шагом каталога', async () => {
    const k = setup();
    const { dialog, menu } = await twoHosts(k);
    const pc = menu.buttons!.flat().find((b) => b.text === 'pc')!;
    await k.press(menu.messageId, pc.data);

    expect(k.store.dialog(NUR_CHAT)?.host).toBe('pc');
    expect(k.telegram.message(NUR_CHAT, menu.messageId)?.text).toBe(
      '🪟 Новое окно на pc. Каталог? Выбери или пришли путь от ~.',
    );
    expect(
      k.telegram
        .message(NUR_CHAT, menu.messageId)
        ?.buttons?.flat()
        .map((b) => b.data),
    ).toEqual([`n:${dialog.token}:d:0`, `n:${dialog.token}:x`]);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('Машина: pc');
  });

  test('машина текстом; каталог кнопкой; задача (многострочная) → запуск, демон разбужен', async () => {
    const k = setup();
    await twoHosts(k);
    await k.say('pc');
    const dirStep = last(k);
    expect(dirStep.text).toStartWith('🪟 Новое окно на pc.');
    await k.press(dirStep.messageId, dirStep.buttons![0]![0]!.data);
    expect(k.telegram.message(NUR_CHAT, dirStep.messageId)?.text).toBe(
      '🪟 Новое окно: pc · ~/dev/site. Задача? Следующее сообщение уйдёт агенту первым.',
    );
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('Каталог: ~/dev/site');

    const polling = k.host.poll({ ...nur, session: { host: 'pc', root: '/x' } }, 50_000);
    await Bun.sleep(0);
    expect(k.waiter.waiting(Waiter.hostTopic('nur', 'pc'))).toBe(1);

    await k.say('Сделай\nзадачу');
    const ack = last(k);
    expect(ack.text).toBe('⏳ Открываю окно на pc…');
    expect(k.store.dialog(NUR_CHAT)).toBeUndefined();

    const [launch] = await polling;
    expect(launch?.toState()).toMatchObject({
      id: 'l_1',
      person: 'nur',
      host: 'pc',
      dir: '/home/nur/dev/site',
      prompt: 'Сделай\nзадачу',
      chatId: NUR_CHAT,
      messageId: ack.replyTo,
    });
  });

  test('каталог текстом — как ввёл человек; шаг задачи — новым сообщением', async () => {
    const k = setup();
    k.online('laptop');
    await k.say('/new');
    await k.say('~/herald-livetest');
    expect(last(k).text).toBe(
      '🪟 Новое окно: laptop · ~/herald-livetest. Задача? Следующее сообщение уйдёт агенту первым.',
    );
    expect(labels(k)).toEqual(['✖ Отмена']);
    await k.say('Привет');
    expect(k.store.launch('l_1')?.dir).toBe('~/herald-livetest');
  });

  test('машина ушла со связи к шагу задачи — запуск всё равно создаётся', async () => {
    const k = setup();
    k.online('laptop');
    await k.say('/new');
    await k.say('dev/x');
    k.clock.advance(Host.ONLINE_MS + 1);
    await k.say('задача');
    expect(k.store.launch('l_1')?.isPending).toBe(true);
  });

  test('неизвестная машина текстом — «⚠️ …», диалог остаётся на шаге', async () => {
    const k = setup();
    await twoHosts(k);
    await k.say('server');
    expect(last(k).text).toBe('⚠️ машины «server» нет на связи — выбери кнопкой');
    expect(k.store.dialog(NUR_CHAT)?.step).toBe('host');
  });

  test('reply на сообщение сессии в диалоге — указание сессии, не диалог', async () => {
    const k = setup();
    k.online('laptop');
    await k.agent.notify(nur, 'x');
    const notice = last(k);
    await k.say('/new');
    await k.say('займись тестами', notice.messageId);
    expect((await k.agent.inbox(nur)).map((i) => i.text)).toEqual(['займись тестами']);
    expect(k.store.dialog(NUR_CHAT)?.step).toBe('dir');
  });

  test('забытый диалог (дольше TTL) не перехватывает текст', async () => {
    const k = setup();
    k.online('laptop');
    await k.say('/new');
    k.clock.advance(NewWindowDialog.TTL_MS + 1);
    await k.say('dev/x');
    expect(last(k).text).toStartWith('Кому?');
    expect(k.store.dialog(NUR_CHAT)).toBeUndefined();
  });
});

describe('/new — отмена и устаревшие кнопки', () => {
  test('/cancel — отмена; без диалога — «нечего отменять»', async () => {
    const k = setup();
    k.online('laptop');
    await k.say('/new');
    await k.say('/cancel');
    expect(last(k).text).toBe('✖ Новое окно отменено.');
    expect(k.store.dialog(NUR_CHAT)).toBeUndefined();
    await k.say('/cancel');
    expect(last(k).text).toBe('Отменять нечего.');
  });

  test('кнопка «Отмена» — диалог удалён, сообщение без кнопок', async () => {
    const k = setup();
    k.online('laptop');
    await k.say('/new');
    const menu = last(k);
    await k.press(menu.messageId, data(k).at(-1)!);
    expect(k.store.dialog(NUR_CHAT)).toBeUndefined();
    expect(k.telegram.message(NUR_CHAT, menu.messageId)).toMatchObject({ text: '✖ Новое окно отменено.' });
    expect(k.telegram.message(NUR_CHAT, menu.messageId)?.buttons).toBeUndefined();
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('Отменено');
  });

  test('другая команда отменяет диалог и выполняется как обычно', async () => {
    const k = setup();
    k.online('laptop');
    await k.say('/new');
    await k.say('/sessions');
    expect(k.store.dialog(NUR_CHAT)).toBeUndefined();
    expect(last(k).text).toBe('Сессий на связи нет.');
  });

  test('выбор сессии в /sessions отменяет диалог', async () => {
    const k = setup();
    k.online('laptop');
    await k.agent.notify(nur, 'x');
    await k.say('/sessions');
    const menu = last(k);
    await k.say('/new');
    await k.press(menu.messageId, menu.buttons![0]![0]!.data);
    expect(k.store.dialog(NUR_CHAT)).toBeUndefined();
  });

  test('кнопка прежнего диалога, другого шага или без диалога — «⚠️ кнопка устарела»', async () => {
    const k = setup();
    k.online('laptop');
    k.online('pc');
    await k.say('/new');
    const first = last(k);
    const old = data(k)[0]!;
    k.clock.advance(1_000);
    await k.say('/new');
    await k.press(first.messageId, old);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('⚠️ кнопка устарела');

    const token = k.store.dialog(NUR_CHAT)!.token;
    await k.press(first.messageId, `n:${token}:d:0`);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('⚠️ кнопка устарела');
    await k.press(first.messageId, `n:${token}:h:9`);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('⚠️ кнопка устарела');
    await k.press(first.messageId, `n:${token}:q`);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('⚠️ кнопка устарела');

    await k.say('/cancel');
    await k.press(first.messageId, `n:${token}:h:0`);
    expect(k.telegram.callbackAnswers.at(-1)?.text).toBe('⚠️ кнопка устарела');
  });
});

describe('Подсказки команд', () => {
  test('«Неизвестная команда» — с /new, /cancel, /exit', async () => {
    const k = setup();
    await k.say('/model');
    expect(last(k).text).toBe('Неизвестная команда. Есть: /new, /sessions, /status, /cancel, /clear, /compact, /exit.');
  });
});
