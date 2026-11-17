import type { PersonId } from './access.ts';
import { DomainError } from './errors.ts';

export type NewWindowStep = 'host' | 'dir' | 'prompt';

/** Машина на связи и последние каталоги её сессий (свежие первыми). */
export interface HostChoice {
  name: string;
  dirs: readonly string[];
}

export interface NewWindowState {
  chatId: number;
  person: PersonId;
  startedAt: number;
  step: NewWindowStep;
  hosts: HostChoice[];
  host?: string;
  dir?: string;
}

/** Всё для запуска окна: машина, каталог (как выбран или введён), задача. */
export interface NewWindowRequest {
  host: string;
  dir: string;
  prompt: string;
}

/**
 * Диалог `/new` в чате: машина → каталог → задача. Одна машина на связи — её шаг пропускается.
 * Машину и каталог выбирают кнопкой (номер в `choices`) или текстом; задача — текстом.
 */
export class NewWindowDialog {
  static readonly MAX_DIRS = 8;
  /** Забытый диалог не должен перехватывать сообщения чата. */
  static readonly TTL_MS = 3_600_000;

  private constructor(private readonly state: NewWindowState) {}

  static start(
    input: { chatId: number; person: PersonId; hosts: readonly HostChoice[] },
    now: number,
  ): NewWindowDialog {
    if (input.hosts.length === 0) throw new DomainError('нет машин на связи');
    const hosts = input.hosts.map((h) => ({ name: h.name, dirs: h.dirs.slice(0, NewWindowDialog.MAX_DIRS) }));
    const dialog = new NewWindowDialog({
      chatId: input.chatId,
      person: input.person,
      startedAt: now,
      step: 'host',
      hosts,
    });
    if (hosts.length === 1) dialog.pickHost(hosts[0] as HostChoice);
    return dialog;
  }

  static restore(state: NewWindowState): NewWindowDialog {
    return new NewWindowDialog({ ...state, hosts: state.hosts.map((h) => ({ ...h, dirs: [...h.dirs] })) });
  }

  get chatId(): number {
    return this.state.chatId;
  }
  get person(): PersonId {
    return this.state.person;
  }
  get startedAt(): number {
    return this.state.startedAt;
  }
  get step(): NewWindowStep {
    return this.state.step;
  }
  get host(): string | undefined {
    return this.state.host;
  }
  get dir(): string | undefined {
    return this.state.dir;
  }
  /** Метка диалога в кнопках: кнопка прежнего диалога — устаревшая. */
  get token(): string {
    return this.state.startedAt.toString(36);
  }

  /** Варианты текущего шага: имена машин или каталоги выбранной машины. */
  get choices(): readonly string[] {
    if (this.state.step === 'host') return this.state.hosts.map((h) => h.name);
    if (this.state.step === 'dir') return this.currentHost().dirs;
    return [];
  }

  isExpired(now: number): boolean {
    return now - this.state.startedAt > NewWindowDialog.TTL_MS;
  }

  /** Кнопка варианта `index` шага `step`. */
  choose(step: NewWindowStep, index: number): void {
    if (step !== this.state.step) throw new DomainError('кнопка устарела');
    const choice = this.choices[index];
    if (choice === undefined) throw new DomainError('кнопка устарела');
    if (step === 'host') this.pickHost(this.state.hosts[index] as HostChoice);
    else this.pickDir(choice);
  }

  /** Текст человека: машина (из предложенных), каталог или задача; задача завершает диалог. */
  input(text: string): NewWindowRequest | undefined {
    const value = text.trim();
    if (!value) throw new DomainError('пустое сообщение');
    if (this.state.step === 'host') {
      const host = this.state.hosts.find((h) => h.name === value);
      if (!host) throw new DomainError(`машины «${value}» нет на связи — выбери кнопкой`);
      this.pickHost(host);
      return undefined;
    }
    if (this.state.step === 'dir') {
      this.pickDir(value);
      return undefined;
    }
    return { host: this.state.host as string, dir: this.state.dir as string, prompt: value };
  }

  toState(): NewWindowState {
    return NewWindowDialog.restore(this.state).state;
  }

  private pickHost(host: HostChoice): void {
    this.state.host = host.name;
    this.state.step = 'dir';
  }

  private pickDir(dir: string): void {
    this.state.dir = dir;
    this.state.step = 'prompt';
  }

  private currentHost(): HostChoice {
    return this.state.hosts.find((h) => h.name === this.state.host) as HostChoice;
  }
}
