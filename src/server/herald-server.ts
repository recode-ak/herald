import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AgentService } from '../app/agent.ts';
import { HumanService } from '../app/human.ts';
import type { Clock, Ids } from '../app/ports.ts';
import { Waiter } from '../app/waiter.ts';
import { HttpApi } from '../http/api.ts';
import { SqliteStore } from '../infra/sqlite-store.ts';
import { RandomIds, SystemClock } from '../infra/system.ts';
import { TelegramBotApi } from '../infra/telegram.ts';
import { TelegramPoller } from '../infra/telegram-poller.ts';
import type { ServerConfig } from './config.ts';

export interface HeraldServerOptions {
  clock?: Clock;
  ids?: Ids;
  log?: (message: string) => void;
}

/** Сервер herald в сборе: SQLite, Telegram (исходящие и опрос), сценарии, HTTP API. */
export class HeraldServer {
  private constructor(
    private readonly http: ReturnType<HttpApi['listen']>,
    private readonly poller: TelegramPoller,
    private readonly store: SqliteStore,
  ) {}

  static start(config: ServerConfig, options: HeraldServerOptions = {}): HeraldServer {
    const clock = options.clock ?? new SystemClock();
    const ids = options.ids ?? new RandomIds();
    const log = options.log ?? ((m: string) => console.log(`${new Date().toISOString()} ${m}`));

    if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
    const store = SqliteStore.open(config.dbPath);
    const telegram = new TelegramBotApi({ token: config.botToken, baseUrl: config.telegramApiUrl, clock });
    const waiter = new Waiter(clock);
    const deps = { store, telegram, access: config.access, clock, ids, waiter };

    const agent = new AgentService(deps);
    const human = new HumanService(deps);
    const http = new HttpApi({ agent, access: config.access, maxWaitMs: config.maxWaitMs, log }).listen({
      port: config.port,
      hostname: config.hostname,
    });
    const poller = new TelegramPoller({ api: telegram, human, store, clock, log });
    poller.start();
    return new HeraldServer(http, poller, store);
  }

  get url(): URL {
    return this.http.url;
  }

  /** Остановка: опрос Telegram обрывается, ждущие long poll закрываются (клиенты переподключатся), база закрывается. */
  async stop(): Promise<void> {
    await this.poller.stop();
    await this.http.stop(true);
    this.store.close();
  }
}
