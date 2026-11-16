import { DomainError } from './errors.ts';

/** Срок хранения записей в днях: что старше границы `cutoff(now)`, удаляет очистка (правила — `docs/model.md`, «Хранение»). */
export class Retention {
  static readonly DAY_MS = 86_400_000;
  static readonly DEFAULT = new Retention(14);

  private constructor(readonly days: number) {}

  static ofDays(days: number): Retention {
    if (!Number.isSafeInteger(days) || days < 1) throw new DomainError(`срок хранения: ${days} — ожидается целое ≥ 1`);
    return new Retention(days);
  }

  /** Граница: записи старше неё (мс эпохи) — к удалению. */
  cutoff(now: number): number {
    return now - this.days * Retention.DAY_MS;
  }
}
