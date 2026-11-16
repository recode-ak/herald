import type { InboxItem, InboxKind } from '../domain/inbox.ts';
import type { Question, QuestionOption, QuestionStatus, Resolution } from '../domain/question.ts';

/** Вопрос в ответе HTTP API. Общий тип для сервера и клиента. */
export interface QuestionWire {
  id: string;
  text: string;
  options: QuestionOption[];
  recommended?: string;
  status: QuestionStatus;
  askedAt: number;
  /** Срок, после которого агент решает сам; нет — решает только человек. */
  deadlineAt?: number;
  heldAt?: number;
  resolution?: Resolution;
  lateAnswers: Resolution[];
}

/** Входящее в ответе HTTP API. */
export interface InboxItemWire {
  id: string;
  kind: InboxKind;
  text: string;
  questionId?: string;
  option?: string;
  createdAt: number;
}

/** Перевод сущностей домена в JSON ответа: без внутренних полей (человек, ключ сессии). */
// biome-ignore lint/complexity/noStaticOnlyClass: правило проекта — класс с зоной ответственности вместо россыпи функций
export class Wire {
  static question(q: Question): QuestionWire {
    const { id, text, options, recommended, status, askedAt, deadlineAt, heldAt, resolution, lateAnswers } =
      q.toState();
    return {
      id,
      text,
      options,
      ...(recommended !== undefined && { recommended }),
      status,
      askedAt,
      ...(deadlineAt !== undefined && { deadlineAt }),
      ...(heldAt !== undefined && { heldAt }),
      ...(resolution && { resolution }),
      lateAnswers,
    };
  }

  static inboxItem(i: InboxItem): InboxItemWire {
    const { id, kind, text, questionId, option, createdAt } = i.toState();
    return {
      id,
      kind,
      text,
      ...(questionId !== undefined && { questionId }),
      ...(option !== undefined && { option }),
      createdAt,
    };
  }
}
