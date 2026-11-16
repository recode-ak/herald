import type { Clock } from '../app/ports.ts';
import type { Store } from '../app/store.ts';
import type { TelegramUpdate } from '../app/telegram.ts';
import type { UpdateBatch } from './telegram.ts';

export interface TelegramPollerDeps {
  api: { getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<UpdateBatch> };
  human: { handle(update: TelegramUpdate): Promise<void> };
  store: Pick<Store, 'telegramOffset' | 'setTelegramOffset'>;
  clock: Clock;
  /** Long poll Telegram, с. */
  pollTimeoutSec?: number;
  /** Пауза после сбоя `getUpdates`. */
  errorDelayMs?: number;
  log?: (message: string) => void;
}

/**
 * Цикл long polling `getUpdates`: апдейты по одному — сценариям человека, offset — в хранилище после каждого.
 * Сбой сценария пишется в лог, апдейт не повторяется (иначе «ядовитый» апдейт остановит бота).
 */
export class TelegramPoller {
  private readonly stopping = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(private readonly deps: TelegramPollerDeps) {}

  start(): void {
    this.loop ??= this.run();
  }

  /** Оборвать текущий опрос и дождаться конца цикла. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { api, human, store, clock } = this.deps;
    const log = this.deps.log ?? console.error;
    const signal = this.stopping.signal;
    while (!signal.aborted) {
      let batch: UpdateBatch;
      try {
        batch = await api.getUpdates(store.telegramOffset(), this.deps.pollTimeoutSec ?? 25, signal);
      } catch (error) {
        if (signal.aborted) return;
        log(`herald: getUpdates: ${TelegramPoller.message(error)}`);
        await clock.sleep(this.deps.errorDelayMs ?? 5000, signal);
        continue;
      }
      for (const update of batch.updates) {
        try {
          await human.handle(update);
        } catch (error) {
          log(`herald: апдейт ${update.updateId}: ${TelegramPoller.message(error)}`);
        }
        store.setTelegramOffset(update.updateId + 1);
      }
      if (batch.nextOffset > store.telegramOffset()) store.setTelegramOffset(batch.nextOffset);
    }
  }

  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
