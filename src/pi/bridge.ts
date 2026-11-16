import type { InboxKind } from '../domain/inbox.ts';
import type { InboxItemWire } from '../http/wire.ts';

/** Что мосту нужно от клиента herald (реализация — `HeraldClient`). */
export interface BridgeHerald {
  inbox(waitMs?: number, kinds?: readonly InboxKind[]): Promise<InboxItemWire[]>;
  ack(ids: readonly string[]): Promise<string[]>;
  notify(text: string): Promise<void>;
  bye(): Promise<void>;
}

/** Агент pi глазами моста (реализация — `HeraldExtension`). */
export interface PiAgent {
  /** Сообщение агенту как от пользователя. */
  say(text: string): Promise<void>;
  /** Команда окна (`/clear`, `/compact`); выполняется, когда агент освободится. */
  run(command: string): Promise<void>;
}

export interface PiBridgeOptions {
  herald: BridgeHerald;
  agent: PiAgent;
  log: (message: string) => void;
  /** Long poll входящих за один запрос клиента. */
  inboxWaitMs?: number;
  /** Пауза после сбоя цикла входящих. */
  retryDelayMs?: number;
}

/**
 * Мост herald ↔ сессия pi: цикл long poll входящих (он же пульс сессии) → сообщение или команда агенту →
 * подтверждение прочтения. Ответы на вопросы не берёт: их ждёт сам `herald ask`, иначе агент получил бы их дважды.
 */
export class PiBridge {
  static readonly KINDS: readonly InboxKind[] = ['directive', 'late-answer', 'command'];

  private running = false;
  private loop: Promise<void> | undefined;
  /** Текущая доставка с подтверждением: закрытие ждёт её, иначе ack после bye снова открыл бы окно. */
  private batch: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;

  constructor(private readonly options: PiBridgeOptions) {}

  start(): void {
    if (this.loop || this.closing) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Остановить цикл; `bye` — окно закрыто (не при `/reload`). Висящий long poll не ждём. */
  stop(options: { bye: boolean }): Promise<void> {
    this.closing ??= this.shutdown(options.bye);
    return this.closing;
  }

  /** Команда не выполнена — сказать человеку. */
  async failed(command: string, error: unknown): Promise<void> {
    try {
      await this.options.herald.notify(`⚠️ ${command} не выполнена: ${PiBridge.message(error)}`);
    } catch (notifyError) {
      this.options.log(`herald: уведомление о ${command} — ${PiBridge.message(notifyError)}`);
    }
  }

  private async shutdown(bye: boolean): Promise<void> {
    this.running = false;
    await this.batch;
    if (!bye) return;
    try {
      await this.options.herald.bye();
    } catch (error) {
      this.options.log(`herald: bye — ${PiBridge.message(error)}`);
    }
  }

  private async run(): Promise<void> {
    const { herald } = this.options;
    let failing = false;
    while (this.running) {
      try {
        const items = await herald.inbox(this.options.inboxWaitMs ?? 50_000, PiBridge.KINDS);
        failing = false;
        if (!this.running) return;
        if (items.length === 0) continue;
        this.batch = this.deliverAll(items);
        await this.batch;
      } catch (error) {
        if (!failing) this.options.log(`herald: входящие недоступны — ${PiBridge.message(error)}`);
        failing = true;
        await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 5_000));
      }
    }
  }

  private async deliverAll(items: readonly InboxItemWire[]): Promise<void> {
    for (const item of items) await this.deliver(item);
    await this.options.herald.ack(items.map((i) => i.id));
  }

  private async deliver(item: InboxItemWire): Promise<void> {
    const { agent } = this.options;
    if (item.kind === 'command') {
      try {
        await agent.run(item.text);
      } catch (error) {
        await this.failed(item.text, error);
      }
      return;
    }
    await agent.say(PiBridge.text(item));
  }

  private static text(item: InboxItemWire): string {
    if (item.kind === 'late-answer') {
      return `Переигрывание вопроса ${item.questionId} (herald): человек ответил «${item.text}» уже после твоего решения по таймауту. Реши, нужно ли переделать.`;
    }
    return `Указание человека из Telegram (herald): ${item.text}\n\nЧеловек читает Telegram, а не терминал: ответ ему — \`herald notify\`.`;
  }

  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
