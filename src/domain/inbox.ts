import type { PersonId } from './access.ts';
import { DomainError } from './errors.ts';

/** `answer` — ответ на вопрос, `late-answer` — ответ на уже решённый вопрос, `directive` — указание человека. */
export type InboxKind = 'answer' | 'late-answer' | 'directive';

export interface InboxDraft {
  id: string;
  sessionKey: string;
  person: PersonId;
  kind: InboxKind;
  text: string;
  questionId?: string;
  option?: string;
}

export interface InboxItemState extends InboxDraft {
  createdAt: number;
  readAt?: number;
}

/** Сообщение во входящих сессии: агент забирает его и подтверждает прочтение. */
export class InboxItem {
  private constructor(private readonly state: InboxItemState) {}

  static create(draft: InboxDraft, now: number): InboxItem {
    const text = draft.text.trim();
    if (!text) throw new DomainError('текст входящего пуст');
    if (draft.kind !== 'directive' && !draft.questionId) throw new DomainError(`${draft.kind} без id вопроса`);
    return new InboxItem({ ...draft, text, createdAt: now });
  }

  static restore(state: InboxItemState): InboxItem {
    return new InboxItem({ ...state });
  }

  get id(): string {
    return this.state.id;
  }
  get sessionKey(): string {
    return this.state.sessionKey;
  }
  get kind(): InboxKind {
    return this.state.kind;
  }
  get text(): string {
    return this.state.text;
  }
  get questionId(): string | undefined {
    return this.state.questionId;
  }
  get option(): string | undefined {
    return this.state.option;
  }
  get createdAt(): number {
    return this.state.createdAt;
  }
  get readAt(): number | undefined {
    return this.state.readAt;
  }
  get isRead(): boolean {
    return this.state.readAt !== undefined;
  }

  /** `true` — прочитано впервые. */
  markRead(now: number): boolean {
    if (this.isRead) return false;
    this.state.readAt = now;
    return true;
  }

  toState(): InboxItemState {
    return { ...this.state };
  }
}

/** Входящие одной сессии: порядок выдачи и подтверждение прочтения. */
export class Inbox {
  private readonly items: ReadonlyMap<string, InboxItem>;

  constructor(
    readonly sessionKey: string,
    items: readonly InboxItem[],
  ) {
    for (const item of items) {
      if (item.sessionKey !== sessionKey) throw new DomainError(`входящее ${item.id} — из другой сессии`);
    }
    this.items = new Map(items.map((i) => [i.id, i]));
  }

  pending(): InboxItem[] {
    return [...this.items.values()]
      .filter((i) => !i.isRead)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** Подтвердить прочтение. Возвращает впервые прочитанные — по ним человеку уходит отметка «прочитано». */
  ack(ids: readonly string[], now: number): InboxItem[] {
    const found = ids.map((id) => {
      const item = this.items.get(id);
      if (!item) throw new DomainError(`входящего ${id} нет в сессии ${this.sessionKey}`);
      return item;
    });
    return found.filter((item) => item.markRead(now));
  }
}
