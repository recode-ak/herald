import type { PersonId } from './access.ts';
import { DomainError } from './errors.ts';

/** Где работает агент: машина и корень git-репо, или явное имя сессии вместо корня. */
export interface SessionRef {
  host: string;
  root: string;
  name?: string;
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
}

/** Сессия агента. Ключ — `host:корень` или `host:@имя`; время — мс эпохи. */
export class Session {
  static readonly STATUS_MAX = 500;

  private constructor(private readonly state: SessionState) {}

  static keyOf(ref: SessionRef): string {
    const { host, root, name } = Session.normalize(ref);
    return name ? `${host}:@${name}` : `${host}:${root}`;
  }

  static open(ref: SessionRef & { person: PersonId }, now: number): Session {
    const { host, root, name } = Session.normalize(ref);
    const project = name ?? root.split('/').filter(Boolean).at(-1) ?? root;
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
  get lastSeenAt(): number {
    return this.state.lastSeenAt;
  }
  get status(): SessionStatus | undefined {
    return this.state.status;
  }

  touch(now: number): void {
    this.state.lastSeenAt = now;
  }

  setStatus(text: string, now: number): void {
    const trimmed = text.trim();
    if (!trimmed) throw new DomainError('статус пуст');
    if (trimmed.length > Session.STATUS_MAX) throw new DomainError(`статус длиннее ${Session.STATUS_MAX} символов`);
    this.state.status = { text: trimmed, at: now };
    this.touch(now);
  }

  isActive(now: number, windowMs: number): boolean {
    return now - this.state.lastSeenAt <= windowMs;
  }

  toState(): SessionState {
    return { ...this.state };
  }

  private static normalize(ref: SessionRef): { host: string; root: string; name?: string } {
    const host = ref.host.trim();
    const root = ref.root.trim().replace(/\/+$/, '') || ref.root.trim();
    const name = ref.name?.trim() || undefined;
    if (!host) throw new DomainError('host пуст');
    if (!root) throw new DomainError('корень сессии пуст');
    return name ? { host, root, name } : { host, root };
  }
}
