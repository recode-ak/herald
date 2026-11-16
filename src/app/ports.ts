import type { PersonId } from '../domain/access.ts';
import type { SessionRef } from '../domain/session.ts';

/** Часы: мс эпохи и сон с отменой. */
export interface Clock {
  now(): number;
  /** Завершается через `ms` или сразу при отмене `signal`. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** Генератор идентификаторов: `next('q')` → `q_…`. */
export interface Ids {
  next(prefix: string): string;
}

/** Кто обращается: человек (по токену) и сессия агента. */
export interface Caller {
  person: PersonId;
  session: SessionRef;
}

/** Нет такого объекта. */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/** Объект чужого человека или чужой чат. */
export class ForbiddenError extends Error {
  override name = 'ForbiddenError';
}
