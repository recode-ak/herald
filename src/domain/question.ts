import type { PersonId } from './access.ts';
import { DomainError } from './errors.ts';

export interface QuestionOption {
  id: string;
  text: string;
}

/** Ответ: выбранный вариант или свободный текст. */
export type Choice = { option: string } | { text: string };

/** Ответ на пункт пачки (нумерация пунктов — с 1). */
export interface ItemAnswer {
  item: number;
  choice: Choice;
}

export interface Resolution {
  by: 'human' | 'agent';
  option?: string;
  text?: string;
  /** Причина решения агента («по таймауту»). */
  reason?: string;
  /** Где ответил человек: `terminal` — в терминале агента (отметил агент); нет — в Telegram. */
  via?: 'terminal';
  at: number;
}

/** Пункт вопроса, как его задаёт агент. */
export interface ItemDraft {
  text: string;
  options: QuestionOption[];
  recommended?: string | undefined;
}

/** Пункт с ответом и поздними ответами. */
export interface QuestionItem extends ItemDraft {
  resolution?: Resolution;
  lateAnswers: Resolution[];
}

interface QuestionBase {
  id: string;
  sessionKey: string;
  person: PersonId;
  /** Сколько агент ждёт ответа, прежде чем решить сам. Без таймаута агент решать не вправе — ждёт человека. */
  timeoutMs?: number | undefined;
}

/** Одиночный вопрос (поля пункта) или пачка (`items`). */
export type QuestionDraft = QuestionBase & (ItemDraft | { items: ItemDraft[] });

export type QuestionStatus = 'open' | 'answered' | 'decided';

export interface QuestionState {
  id: string;
  sessionKey: string;
  person: PersonId;
  items: QuestionItem[];
  status: QuestionStatus;
  askedAt: number;
  /** Срок, после которого агент решает сам; нет — решать агенту нельзя. */
  deadlineAt?: number;
  heldAt?: number;
  /** Человек ответит в терминале агента: бот больше не присылает пункты, агенту решать нельзя. */
  terminalAt?: number;
}

/**
 * Вопрос агента человеку — пачка из 1–10 пунктов с общим сроком; одиночный вопрос — пачка из одного.
 * `open → answered` (человек ответил на все пункты) или `open → decided` (агент решил неотвеченные).
 * Ответ человека на пункт решённого вопроса — поздний: сохраняется, решение не меняет.
 * Решать агенту можно только вопрос с таймаутом; «Жди меня» (`hold`) и перевод в терминал снимают это право.
 */
export class Question {
  static readonly MAX_ITEMS = 10;

  private constructor(private readonly state: QuestionState) {}

  static ask(draft: QuestionDraft, now: number): Question {
    const drafts = 'items' in draft ? draft.items : [draft];
    if (drafts.length < 1 || drafts.length > Question.MAX_ITEMS) {
      throw new DomainError(`в вопросе 1–${Question.MAX_ITEMS} пунктов, а не ${drafts.length}`);
    }
    const items = drafts.map((d, i) => Question.item(d, 'items' in draft ? `пункт ${i + 1}: ` : ''));
    const { timeoutMs } = draft;
    if (timeoutMs !== undefined && !(Number.isSafeInteger(timeoutMs) && timeoutMs >= 0)) {
      throw new DomainError(`таймаут ${timeoutMs} — ожидается целое число мс ≥ 0`);
    }
    return new Question({
      id: draft.id,
      sessionKey: draft.sessionKey,
      person: draft.person,
      items,
      status: 'open',
      askedAt: now,
      ...(timeoutMs !== undefined && { deadlineAt: now + timeoutMs }),
    });
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
  get items(): readonly QuestionItem[] {
    return this.state.items;
  }
  /** Пачка — больше одного пункта. */
  get isBatch(): boolean {
    return this.state.items.length > 1;
  }
  /** Текущий пункт — первый неотвеченный (номер с 1); все отвечены — `undefined`. */
  get current(): number | undefined {
    const index = this.state.items.findIndex((i) => i.resolution === undefined);
    return index < 0 ? undefined : index + 1;
  }
  /** Текст первого пункта (у одиночного вопроса — сам вопрос). */
  get text(): string {
    return this.first.text;
  }
  get options(): readonly QuestionOption[] {
    return this.first.options;
  }
  get recommended(): string | undefined {
    return this.first.recommended;
  }
  get resolution(): Resolution | undefined {
    return this.first.resolution;
  }
  get lateAnswers(): readonly Resolution[] {
    return this.first.lateAnswers;
  }
  get status(): QuestionStatus {
    return this.state.status;
  }
  get askedAt(): number {
    return this.state.askedAt;
  }
  get deadlineAt(): number | undefined {
    return this.state.deadlineAt;
  }
  get heldAt(): number | undefined {
    return this.state.heldAt;
  }
  get terminalAt(): number | undefined {
    return this.state.terminalAt;
  }

  /** Пункт по номеру (с 1). */
  item(n: number): QuestionItem {
    const item = Number.isInteger(n) ? this.state.items[n - 1] : undefined;
    if (!item) throw new DomainError(`вопрос ${this.id}: пункта ${n} нет`);
    return item;
  }

  /**
   * Ответ человека на пункт `n`. Вопрос открыт — ответ записан (повторный заменяет прежний),
   * отвечены все пункты — `answered`. Вопрос решён — `late`: ответ сохранён как поздний.
   */
  answer(choice: Choice, now: number, n = 1): 'answer' | 'late' {
    const item = this.item(n);
    const resolution: Resolution = { by: 'human', ...Question.validate(item, choice), at: now };
    if (this.state.status !== 'open') {
      item.lateAnswers.push(resolution);
      return 'late';
    }
    item.resolution = resolution;
    this.complete();
    return 'answer';
  }

  /** Человек ответил в терминале агента — отмечает агент. Только для открытого вопроса. */
  answerInTerminal(answers: Choice | readonly ItemAnswer[], now: number): void {
    if (this.state.status !== 'open') throw new DomainError(`вопрос ${this.id} уже решён`);
    const checked = this.check(Question.answers(answers));
    for (const [item, choice] of checked) item.resolution = { by: 'human', ...choice, via: 'terminal', at: now };
    this.complete();
  }

  /**
   * Решение агента по неотвеченным пунктам (например, по таймауту): ответ агента на пункт или рекомендованный.
   * Ответы человека остаются; ответы агента на уже отвеченные пункты не учитываются.
   */
  decide(answers: Choice | readonly ItemAnswer[], reason: string, now: number): void {
    if (this.state.status !== 'open') throw new DomainError(`вопрос ${this.id} уже решён`);
    if (this.state.deadlineAt === undefined) {
      throw new DomainError(`вопрос ${this.id} задан без таймаута: решает человек`);
    }
    if (this.state.heldAt !== undefined) throw new DomainError(`вопрос ${this.id}: человек просил ждать`);
    if (this.state.terminalAt !== undefined) {
      throw new DomainError(`вопрос ${this.id} переведён в терминал: решает человек`);
    }
    const why = reason.trim();
    if (!why) throw new DomainError('у решения нет причины');
    const given = new Map(this.check(Question.answers(answers)));
    const decisions = this.state.items.flatMap((item, i): [QuestionItem, Choice][] => {
      if (item.resolution) return [];
      const choice = given.get(item) ?? (item.recommended !== undefined ? { option: item.recommended } : undefined);
      if (!choice) {
        throw new DomainError(`вопрос ${this.id}: пункт ${i + 1} — нет ни ответа агента, ни рекомендованного`);
      }
      return [[item, choice]];
    });
    for (const [item, choice] of decisions) item.resolution = { by: 'agent', ...choice, reason: why, at: now };
    this.state.status = 'decided';
  }

  /** «Жди меня»: человек ответит сам, агенту решать нельзя. */
  hold(now: number): void {
    if (this.state.status !== 'open') throw new DomainError(`вопрос ${this.id} уже решён`);
    this.state.heldAt = now;
  }

  /** Человек ответит в терминале агента. Повтор — без изменений. */
  moveToTerminal(now: number): void {
    if (this.state.status !== 'open') throw new DomainError(`вопрос ${this.id} уже решён`);
    this.state.terminalAt ??= now;
  }

  toState(): QuestionState {
    return structuredClone(this.state);
  }

  private get first(): QuestionItem {
    return this.state.items[0] as QuestionItem;
  }

  private complete(): void {
    if (this.state.items.every((i) => i.resolution !== undefined)) this.state.status = 'answered';
  }

  /** Одиночный ответ — на пункт 1. */
  private static answers(answers: Choice | readonly ItemAnswer[]): readonly ItemAnswer[] {
    return Array.isArray(answers) ? answers : [{ item: 1, choice: answers as Choice }];
  }

  /** Проверить все ответы до записи: ошибка в одном — ничего не записано. */
  private check(answers: readonly ItemAnswer[]): [QuestionItem, Choice][] {
    return answers.map((a) => {
      const item = this.item(a.item);
      return [item, Question.validate(item, a.choice)];
    });
  }

  private static item(draft: ItemDraft, where: string): QuestionItem {
    const text = draft.text.trim();
    if (!text) throw new DomainError(`${where}текст вопроса пуст`);
    const options = draft.options.map((o) => ({ id: o.id.trim(), text: o.text.trim() }));
    const ids = new Set<string>();
    for (const o of options) {
      if (!o.id || !o.text) throw new DomainError(`${where}у варианта пустой id или текст`);
      if (ids.has(o.id)) throw new DomainError(`${where}вариант «${o.id}» повторяется`);
      ids.add(o.id);
    }
    if (draft.recommended !== undefined && !ids.has(draft.recommended)) {
      throw new DomainError(`${where}рекомендованный «${draft.recommended}» — не из вариантов`);
    }
    return {
      text,
      options,
      ...(draft.recommended !== undefined && { recommended: draft.recommended }),
      lateAnswers: [],
    };
  }

  private static validate(item: QuestionItem, choice: Choice): Choice {
    if ('option' in choice) {
      if (!item.options.some((o) => o.id === choice.option)) {
        throw new DomainError(`варианта «${choice.option}» нет`);
      }
      return { option: choice.option };
    }
    const text = choice.text.trim();
    if (!text) throw new DomainError('ответ пуст');
    return { text };
  }
}
