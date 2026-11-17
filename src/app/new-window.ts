import type { PersonId } from '../domain/access.ts';
import { Launch } from '../domain/host.ts';
import { type HostChoice, NewWindowDialog } from '../domain/new-window.ts';
import { Messages } from './messages.ts';
import type { Clock, Ids } from './ports.ts';
import type { Store } from './store.ts';
import type { TelegramPort } from './telegram.ts';
import { Waiter } from './waiter.ts';

export interface NewWindowBotDeps {
  store: Store;
  telegram: TelegramPort;
  clock: Clock;
  ids: Ids;
  waiter: Waiter;
}

/** Сообщение чата, на которое отвечает бот. */
interface ChatMessage {
  chatId: number;
  messageId: number;
}

/**
 * Диалог `/new` в боте: машина → каталог → задача → запуск окна для демона машины.
 * Ответ бота (строка) `HumanService` шлёт reply на сообщение человека или всплывающим текстом кнопки.
 */
export class NewWindowBot {
  constructor(private readonly deps: NewWindowBotDeps) {}

  /** `/new`: новый диалог вместо прежнего; выбранный в `/sessions` адресат сбрасывается. */
  async start(person: PersonId, chatId: number): Promise<string | undefined> {
    const { store, clock, telegram } = this.deps;
    store.setChatTarget(chatId, undefined);
    const hosts = this.hostChoices(person);
    if (hosts.length === 0) {
      store.deleteDialog(chatId);
      return Messages.NO_HOSTS;
    }
    const dialog = NewWindowDialog.start({ chatId, person, hosts }, clock.now());
    store.saveDialog(dialog);
    await telegram.send({
      chatId,
      text: Messages.newWindowStep(dialog),
      buttons: Messages.newWindowButtons(dialog),
    });
    return undefined;
  }

  /** `/cancel`. */
  cancel(chatId: number): string {
    const live = this.active(chatId);
    this.deps.store.deleteDialog(chatId);
    return live ? Messages.NEW_WINDOW_CANCELLED : Messages.NOTHING_TO_CANCEL;
  }

  /** Диалог прерван другой командой или выбором адресата. */
  drop(chatId: number): void {
    this.deps.store.deleteDialog(chatId);
  }

  /** Живой диалог чата; забытый (дольше `TTL_MS`) удаляется. */
  active(chatId: number): NewWindowDialog | undefined {
    const dialog = this.deps.store.dialog(chatId);
    if (!dialog) return undefined;
    if (!dialog.isExpired(this.deps.clock.now())) return dialog;
    this.deps.store.deleteDialog(chatId);
    return undefined;
  }

  /** Текст человека в живом диалоге: машина, каталог или задача (задача создаёт запуск). */
  async input(dialog: NewWindowDialog, text: string, message: ChatMessage): Promise<string | undefined> {
    const { store, clock, ids, waiter, telegram } = this.deps;
    const request = dialog.input(text);
    if (!request) {
      store.saveDialog(dialog);
      await telegram.send({
        chatId: message.chatId,
        text: Messages.newWindowStep(dialog),
        buttons: Messages.newWindowButtons(dialog),
      });
      return undefined;
    }
    const launch = Launch.create({ ...request, id: ids.next('l'), person: dialog.person, ...message }, clock.now());
    store.transaction(() => {
      store.saveLaunch(launch);
      store.deleteDialog(message.chatId);
    });
    waiter.notify(Waiter.hostTopic(launch.person, launch.host));
    return Messages.launching(launch.host);
  }

  /**
   * Кнопка диалога: `<метка>:h:<номер>`, `<метка>:d:<номер>`, `<метка>:x`. Выбор перерисовывает сообщение
   * следующим шагом. Возвращает всплывающий текст.
   */
  async press(parts: readonly string[], message: ChatMessage): Promise<string> {
    const { store, telegram } = this.deps;
    const [token, kind, index, ...rest] = parts;
    const dialog = this.active(message.chatId);
    if (!dialog || token !== dialog.token || rest.length > 0) return Messages.STALE_BUTTON;
    if (kind === 'x' && index === undefined) {
      store.deleteDialog(message.chatId);
      await telegram.edit(message.chatId, message.messageId, Messages.NEW_WINDOW_CANCELLED);
      return 'Отменено';
    }
    const step = kind === 'h' ? 'host' : kind === 'd' ? 'dir' : undefined;
    const n = Number(index);
    if (!step || index === undefined || !Number.isSafeInteger(n)) return Messages.STALE_BUTTON;
    // Не тот шаг или номер — DomainError «кнопка устарела».
    dialog.choose(step, n);
    store.saveDialog(dialog);
    await telegram.edit(
      message.chatId,
      message.messageId,
      Messages.newWindowStep(dialog),
      Messages.newWindowButtons(dialog),
    );
    return step === 'host' ? `Машина: ${dialog.host}` : `Каталог: ${Messages.dirLabel(dialog.dir ?? '')}`;
  }

  /** Машины на связи (недавние первыми) и корни их сессий — свежие первыми, без повторов. */
  private hostChoices(person: PersonId): HostChoice[] {
    const { store, clock } = this.deps;
    const now = clock.now();
    const sessions = store.sessionsOf(person);
    return store
      .hostsOf(person)
      .filter((h) => h.isOnline(now))
      .map((h) => ({
        name: h.name,
        dirs: [...new Set(sessions.filter((s) => s.host === h.name).map((s) => s.root))],
      }));
  }
}
