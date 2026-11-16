import type { PersonId } from './access.ts';
import { DomainError } from './errors.ts';

export interface QuestionOption {
  id: string;
  text: string;
}

/** Ответ: выбранный вариант или свободный текст. */
export type Choice = { option: string } | { text: string };

export interface Resolution {
  by: 'human' | 'agent';
  option?: string;
  text?: string;
  /** Причина решения агента («по таймауту»). */
  reason?: string;
  at: number;
}

export interface QuestionDraft {
  id: string;
  sessionKey: string;
  person: PersonId;
  text: string;
  options: QuestionOption[];
  recommended?: string;
}

export type QuestionStatus = 'open' | 'answered' | 'decided';

export interface QuestionState extends QuestionDraft {
  status: QuestionStatus;
  askedAt: number;
  heldAt?: number;
  resolution?: Resolution;
  lateAnswers: Resolution[];
}

/**
 * Вопрос агента человеку. `open → answered` (ответ человека) или `open → decided` (решение агента).
 * Ответ человека после решения или повторный — поздний: сохраняется, первое решение не меняет.
 * «Жди меня» (`hold`) запрещает агенту решать вопрос.
 */
export class Question {
  private constructor(private readonly state: QuestionState) {}

  static ask(draft: QuestionDraft, now: number): Question {
    const text = draft.text.trim();
    if (!text) throw new DomainError('текст вопроса пуст');
    const options = draft.options.map((o) => ({ id: o.id.trim(), text: o.text.trim() }));
    const ids = new Set<string>();
    for (const o of options) {
      if (!o.id || !o.text) throw new DomainError('у варианта пустой id или текст');
      if (ids.has(o.id)) throw new DomainError(`вариант «${o.id}» повторяется`);
      ids.add(o.id);
    }
    if (draft.recommended !== undefined && !ids.has(draft.recommended)) {
      throw new DomainError(`рекомендованный «${draft.recommended}» — не из вариантов`);
    }
    return new Question({ ...draft, text, options, status: 'open', askedAt: now, lateAnswers: [] });
  }

  static restore(state: QuestionState): Question {
    return new Question(structuredClone(state));
  }

  get id(): string {
    return this.state.id;
  }
  get sessionKey(): string {
    return this.state.sessionKey;
  }
  get person(): PersonId {
    return this.state.person;
  }
  get text(): string {
    return this.state.text;
  }
  get options(): readonly QuestionOption[] {
    return this.state.options;
  }
  get recommended(): string | undefined {
    return this.state.recommended;
  }
  get status(): QuestionStatus {
    return this.state.status;
  }
  get askedAt(): number {
    return this.state.askedAt;
  }
  get heldAt(): number | undefined {
    return this.state.heldAt;
  }
  get resolution(): Resolution | undefined {
    return this.state.resolution;
  }
  get lateAnswers(): readonly Resolution[] {
    return this.state.lateAnswers;
  }

  /** Ответ человека. `late` — вопрос уже решён, ответ сохранён как поздний. */
  answer(choice: Choice, now: number): 'answer' | 'late' {
    const resolution: Resolution = { by: 'human', ...this.validate(choice), at: now };
    if (this.state.status !== 'open') {
      this.state.lateAnswers.push(resolution);
      return 'late';
    }
    this.state.resolution = resolution;
    this.state.status = 'answered';
    return 'answer';
  }

  /** Решение агента без ответа человека (например, по таймауту). */
  decide(choice: Choice, reason: string, now: number): void {
    if (this.state.status !== 'open') throw new DomainError(`вопрос ${this.id} уже решён`);
    if (this.state.heldAt !== undefined) throw new DomainError(`вопрос ${this.id}: человек просил ждать`);
    const why = reason.trim();
    if (!why) throw new DomainError('у решения нет причины');
    this.state.resolution = { by: 'agent', ...this.validate(choice), reason: why, at: now };
    this.state.status = 'decided';
  }

  /** «Жди меня»: человек ответит сам, агенту решать нельзя. */
  hold(now: number): void {
    if (this.state.status !== 'open') throw new DomainError(`вопрос ${this.id} уже решён`);
    this.state.heldAt = now;
  }

  toState(): QuestionState {
    return structuredClone(this.state);
  }

  private validate(choice: Choice): { option: string } | { text: string } {
    if ('option' in choice) {
      if (!this.state.options.some((o) => o.id === choice.option)) {
        throw new DomainError(`варианта «${choice.option}» нет`);
      }
      return { option: choice.option };
    }
    const text = choice.text.trim();
    if (!text) throw new DomainError('ответ пуст');
    return { text };
  }
}
