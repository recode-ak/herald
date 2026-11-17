import type { Launch } from '../domain/host.ts';
import type { InboxItem, InboxKind } from '../domain/inbox.ts';
import type { Question, QuestionItem, QuestionOption, QuestionStatus, Resolution } from '../domain/question.ts';

/**
 * Вопрос в ответе HTTP API. Общий тип для сервера и клиента. `items` — пункты пачки; плоские `text`, `options`,
 * `recommended`, `resolution`, `lateAnswers` — первый пункт (у одиночного вопроса — сам вопрос, как до пачек).
 */
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
  /** Человек ответит в терминале агента. */
  terminalAt?: number;
  resolution?: Resolution;
  lateAnswers: Resolution[];
  items: QuestionItem[];
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

/** Запуск окна в ответе `/v1/host/poll`: что открыть демону. Каталог — как ввёл человек (от `~`). */
export interface LaunchWire {
  id: string;
  dir: string;
  prompt: string;
  createdAt: number;
}

/** Перевод сущностей домена в JSON ответа: без внутренних полей (человек, ключ сессии). */
// biome-ignore lint/complexity/noStaticOnlyClass: правило проекта — класс с зоной ответственности вместо россыпи функций
export class Wire {
  static question(q: Question): QuestionWire {
    const { id, status, askedAt, deadlineAt, heldAt, terminalAt, items } = q.toState();
    const { text, options, recommended, resolution, lateAnswers } = items[0] as QuestionItem;
    return {
      id,
      text,
      options,
      ...(recommended !== undefined && { recommended }),
      status,
      askedAt,
      ...(deadlineAt !== undefined && { deadlineAt }),
      ...(heldAt !== undefined && { heldAt }),
      ...(terminalAt !== undefined && { terminalAt }),
      ...(resolution && { resolution }),
      lateAnswers,
      items,
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

  static launch(l: Launch): LaunchWire {
    const { id, dir, prompt, createdAt } = l.toState();
    return { id, dir, prompt, createdAt };
  }
}
