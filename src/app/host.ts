import { Host, type Launch, type LaunchOutcome } from '../domain/host.ts';
import { Messages } from './messages.ts';
import { type Caller, type Clock, ForbiddenError, NotFoundError } from './ports.ts';
import type { Store } from './store.ts';
import type { TelegramPort } from './telegram.ts';
import { Waiter } from './waiter.ts';

export interface HostDeps {
  store: Store;
  telegram: TelegramPort;
  clock: Clock;
  waiter: Waiter;
}

/**
 * Сценарии демона машины (`herald host`): опрос запусков окон по `/new` и их итог.
 * Машина — `caller.session.host`; каждое обращение отмечает её на связи.
 */
export class HostService {
  constructor(private readonly deps: HostDeps) {}

  /** Невыданные запуски машины — выдаются сразу и один раз; нет — ждать первых до `waitMs`, по таймауту пусто. */
  async poll(caller: Caller, waitMs: number): Promise<Launch[]> {
    const { clock, waiter } = this.deps;
    const deadline = clock.now() + waitMs;
    const topic = Waiter.hostTopic(caller.person, caller.session.host.trim());
    for (;;) {
      const launches = this.take(caller);
      const left = deadline - clock.now();
      if (launches.length > 0 || left <= 0) return launches;
      await waiter.wait(topic, left);
    }
  }

  /**
   * Итог запуска (один раз) — человеку reply на его сообщение с задачей.
   * Итог сохраняется до отправки: сбой Telegram не даст повторить запуск и продублировать итог.
   */
  async done(caller: Caller, id: string, outcome: LaunchOutcome): Promise<void> {
    const { store, telegram, clock } = this.deps;
    const launch = store.transaction(() => {
      const host = this.seen(caller);
      const found = store.launch(id);
      if (!found) throw new NotFoundError(`запуска ${id} нет`);
      if (found.person !== host.person || found.host !== host.name) {
        throw new ForbiddenError(`запуск ${id} — не этой машины`);
      }
      found.finish(outcome, clock.now());
      store.saveLaunch(found);
      return found;
    });
    await telegram.send({ chatId: launch.chatId, text: Messages.launchOutcome(launch), replyTo: launch.messageId });
  }

  private take(caller: Caller): Launch[] {
    const { store, clock } = this.deps;
    return store.transaction(() => {
      const host = this.seen(caller);
      const launches = store.pendingLaunches(host.person, host.name);
      for (const launch of launches) {
        launch.take(clock.now());
        store.saveLaunch(launch);
      }
      return launches;
    });
  }

  /** Отметить машину вызывающего на связи. */
  private seen(caller: Caller): Host {
    const { store, clock } = this.deps;
    const ref = { person: caller.person, name: caller.session.host };
    const host = Host.seen(ref, clock.now());
    const existing = store.host(host.person, host.name);
    existing?.touch(clock.now());
    store.saveHost(existing ?? host);
    return existing ?? host;
  }
}
