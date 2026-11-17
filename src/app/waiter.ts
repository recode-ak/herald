import type { Clock } from './ports.ts';

/**
 * Ожидание событий в памяти процесса сервера: long poll HTTP ждёт темы, сценарии человека их будят.
 * Темы: `q:<id вопроса>` — вопрос получил ответ, `s:<ключ сессии>` — новое входящее,
 * `h:<человек>:<машина>` — новый запуск окна для демона машины.
 * Событие не хранится: ждущий сначала проверяет хранилище, потом ждёт (без `await` между ними).
 */
export class Waiter {
  private readonly topics = new Map<string, Set<() => void>>();

  constructor(private readonly clock: Clock) {}

  static questionTopic(questionId: string): string {
    return `q:${questionId}`;
  }

  static sessionTopic(sessionKey: string): string {
    return `s:${sessionKey}`;
  }

  static hostTopic(person: string, host: string): string {
    return `h:${person}:${host}`;
  }

  /** `true` — пришло событие темы, `false` — истёк таймаут. */
  wait(topic: string, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return Promise.resolve(false);
    const timer = new AbortController();
    let wake!: () => void;
    const event = new Promise<true>((resolve) => {
      wake = () => resolve(true);
    });
    const waiters = this.topics.get(topic) ?? new Set();
    waiters.add(wake);
    this.topics.set(topic, waiters);

    const timeout = this.clock.sleep(timeoutMs, timer.signal).then(() => false as const);
    return Promise.race([event, timeout]).finally(() => {
      timer.abort();
      waiters.delete(wake);
      if (waiters.size === 0 && this.topics.get(topic) === waiters) this.topics.delete(topic);
    });
  }

  notify(topic: string): void {
    for (const wake of this.topics.get(topic) ?? []) wake();
  }

  /** Сколько ждут тему (для тестов и диагностики). */
  waiting(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }
}
