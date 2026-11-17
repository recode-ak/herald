import type { PersonId } from './access.ts';
import { DomainError } from './errors.ts';
import { Session } from './session.ts';

export interface HostState {
  person: PersonId;
  /** Имя машины — `host` из настроек клиента. */
  name: string;
  lastSeenAt: number;
}

/** Машина человека, где работает демон `herald host`; на связи, пока он опрашивает сервер. */
export class Host {
  /** Как у сессии: демон опрашивает long poll ≤ 50 с. */
  static readonly ONLINE_MS = Session.ONLINE_MS;

  private constructor(private readonly state: HostState) {}

  static seen(ref: { person: PersonId; name: string }, now: number): Host {
    const name = ref.name.trim();
    if (!name) throw new DomainError('имя машины пусто');
    return new Host({ person: ref.person, name, lastSeenAt: now });
  }

  static restore(state: HostState): Host {
    return new Host({ ...state });
  }

  get person(): PersonId {
    return this.state.person;
  }
  get name(): string {
    return this.state.name;
  }
  get lastSeenAt(): number {
    return this.state.lastSeenAt;
  }

  touch(now: number): void {
    this.state.lastSeenAt = now;
  }

  isOnline(now: number): boolean {
    return now - this.state.lastSeenAt <= Host.ONLINE_MS;
  }

  toState(): HostState {
    return { ...this.state };
  }
}

export interface LaunchDraft {
  id: string;
  person: PersonId;
  /** Имя машины. */
  host: string;
  /** Каталог, как ввёл человек: проверяет и раскрывает демон (от `~`). */
  dir: string;
  /** Задача — первым сообщением агенту. */
  prompt: string;
  /** Сообщение человека с задачей: на него — reply с итогом. */
  chatId: number;
  messageId: number;
}

export interface LaunchOutcome {
  ok: boolean;
  text: string;
}

export interface LaunchState extends LaunchDraft {
  createdAt: number;
  takenAt?: number;
  finishedAt?: number;
  outcome?: LaunchOutcome;
}

/**
 * Запуск окна агента на машине по `/new`. Выдаётся демону один раз: потерять запуск при падении демона лучше,
 * чем открыть окно дважды. Итог — один раз.
 */
export class Launch {
  private constructor(private readonly state: LaunchState) {}

  static create(draft: LaunchDraft, now: number): Launch {
    const host = draft.host.trim();
    const dir = draft.dir.trim();
    const prompt = draft.prompt.trim();
    if (!host) throw new DomainError('имя машины пусто');
    if (!dir) throw new DomainError('каталог пуст');
    if (!prompt) throw new DomainError('задача пуста');
    return new Launch({ ...draft, host, dir, prompt, createdAt: now });
  }

  static restore(state: LaunchState): Launch {
    return new Launch({ ...state });
  }

  get id(): string {
    return this.state.id;
  }
  get person(): PersonId {
    return this.state.person;
  }
  get host(): string {
    return this.state.host;
  }
  get dir(): string {
    return this.state.dir;
  }
  get prompt(): string {
    return this.state.prompt;
  }
  get chatId(): number {
    return this.state.chatId;
  }
  get messageId(): number {
    return this.state.messageId;
  }
  get takenAt(): number | undefined {
    return this.state.takenAt;
  }
  get finishedAt(): number | undefined {
    return this.state.finishedAt;
  }
  get outcome(): LaunchOutcome | undefined {
    return this.state.outcome;
  }
  /** Ещё не выдан демону. */
  get isPending(): boolean {
    return this.state.takenAt === undefined;
  }

  take(now: number): void {
    if (this.state.takenAt !== undefined) throw new DomainError(`запуск ${this.state.id} уже выдан`);
    this.state.takenAt = now;
  }

  finish(outcome: LaunchOutcome, now: number): void {
    if (this.state.takenAt === undefined) throw new DomainError(`запуск ${this.state.id} не выдан`);
    if (this.state.outcome) throw new DomainError(`у запуска ${this.state.id} уже есть итог`);
    const text = outcome.text.trim();
    if (!text) throw new DomainError('текст итога пуст');
    this.state.outcome = { ok: outcome.ok, text };
    this.state.finishedAt = now;
  }

  toState(): LaunchState {
    return { ...this.state, ...(this.state.outcome && { outcome: { ...this.state.outcome } }) };
  }
}
