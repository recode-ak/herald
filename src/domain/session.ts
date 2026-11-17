import type { PersonId } from './access.ts';
import { DomainError } from './errors.ts';

/**
 * Где работает агент: машина и корень git-репо, или явное имя сессии вместо корня.
 * `instance` — окно агента в том же корне (параллельные сессии Claude Code); при явном имени не учитывается.
 */
export interface SessionRef {
  host: string;
  root: string;
  name?: string;
  instance?: string;
}

export interface SessionStatus {
  text: string;
  at: number;
}

export interface SessionState {
  key: string;
  person: PersonId;
  host: string;
  project: string;
  root: string;
  lastSeenAt: number;
  status?: SessionStatus;
  /** Название от агента — что делает сессия; в шапке после проекта. */
  title?: string;
  /** Окно агента закрыто (канал сообщил при выходе); снимается следующим обращением. */
  closedAt?: number;
}

/** Сессия агента. Ключ — `host:корень`, `host:корень#окно` или `host:@имя`; время — мс эпохи. */
export class Session {
  static readonly STATUS_MAX = 500;
  static readonly TITLE_MAX = 60;
  /** На связи — обращалась не дольше этого (канал опрашивает ящик long poll ≤ 50 с). */
  static readonly ONLINE_MS = 120_000;

  private constructor(private readonly state: SessionState) {}

  static keyOf(ref: SessionRef): string {
    const { host, root, name, instance } = Session.normalize(ref);
    if (name) return `${host}:@${name}`;
    return instance ? `${host}:${root}#${instance}` : `${host}:${root}`;
  }

  static open(ref: SessionRef & { person: PersonId }, now: number): Session {
    const { host, root, name, instance } = Session.normalize(ref);
    const base = root.split('/').filter(Boolean).at(-1) ?? root;
    const project = name ?? (instance ? `${base}·${instance}` : base);
    return new Session({ key: Session.keyOf(ref), person: ref.person, host, project, root, lastSeenAt: now });
  }

  static restore(state: SessionState): Session {
    return new Session({ ...state });
  }

  get key(): string {
    return this.state.key;
  }
  get person(): PersonId {
    return this.state.person;
  }
  get host(): string {
    return this.state.host;
  }
  get project(): string {
    return this.state.project;
  }
  /** Корень проекта на машине (каталог, где запущен агент). */
  get root(): string {
    return this.state.root;
  }
  get lastSeenAt(): number {
    return this.state.lastSeenAt;
  }
  get status(): SessionStatus | undefined {
    return this.state.status;
  }
  get title(): string | undefined {
    return this.state.title;
  }
  get closedAt(): number | undefined {
    return this.state.closedAt;
  }
  /** Как сессию видит человек: проект и название, если есть. */
  get label(): string {
    return this.state.title ? `${this.state.project} · ${this.state.title}` : this.state.project;
  }

  touch(now: number): void {
    this.state.lastSeenAt = now;
    delete this.state.closedAt;
  }

  /** Окно агента закрыто: сессия не на связи до следующего обращения. */
  close(now: number): void {
    this.state.closedAt = now;
  }

  /** Агент сейчас слушает: недавнее обращение и окно не закрыто. */
  isOnline(now: number): boolean {
    return this.state.closedAt === undefined && now - this.state.lastSeenAt <= Session.ONLINE_MS;
  }

  setStatus(text: string, now: number): void {
    const trimmed = text.trim();
    if (!trimmed) throw new DomainError('статус пуст');
    if (trimmed.length > Session.STATUS_MAX) throw new DomainError(`статус длиннее ${Session.STATUS_MAX} символов`);
    this.state.status = { text: trimmed, at: now };
    this.touch(now);
  }

  setTitle(text: string, now: number): void {
    const trimmed = text.trim();
    if (!trimmed) throw new DomainError('название сессии пусто');
    if (trimmed.length > Session.TITLE_MAX) throw new DomainError(`название длиннее ${Session.TITLE_MAX} символов`);
    this.state.title = trimmed;
    this.touch(now);
  }

  toState(): SessionState {
    return { ...this.state };
  }

  private static normalize(ref: SessionRef): { host: string; root: string; name?: string; instance?: string } {
    const host = ref.host.trim();
    const root = ref.root.trim().replace(/\/+$/, '') || ref.root.trim();
    const name = ref.name?.trim() || undefined;
    const instance = ref.instance?.trim() || undefined;
    if (!host) throw new DomainError('host пуст');
    if (!root) throw new DomainError('корень сессии пуст');
    if (name) return { host, root, name };
    return instance ? { host, root, instance } : { host, root };
  }
}
