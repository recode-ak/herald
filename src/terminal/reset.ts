import type { Clock } from '../app/ports.ts';
import type { HookEvent, HookSignal } from './signals.ts';
import type { Terminal } from './terminal.ts';

/** Откуда самосброс узнаёт о хуках окна (реализация — `HookSignals`). */
export interface SignalReader {
  last(pane: string, event: HookEvent, since: number): HookSignal | undefined;
}

export interface SelfResetDeps {
  /** Панель tmux окна агента — только для чтения меток. */
  pane: string;
  terminal: Terminal;
  signals: SignalReader;
  clock: Clock;
  /** Уведомление человеку (herald notify). */
  notify: (text: string) => Promise<void>;
}

/** Что набрать: команда (с `/`), затем сообщение для продолжения. */
export interface SelfResetPlan {
  command: string;
  message?: string;
  /** Срок ожидания каждого сигнала хука. */
  timeoutMs: number;
  /** Режим без хуков: команда сразу, сообщение — через столько мс. */
  delayMs?: number;
}

export type SelfResetOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Самосброс агента: набрать в своё окно команду (`/clear`, `/compact`…), а после неё — сообщение,
 * с которого агент продолжит работу. Моменты набора — по хукам Claude Code, а не по таймеру:
 * `Stop` — ход закончен и поле ввода свободно; `SessionStart` с `source` команды — сброс или сжатие завершены.
 * Не дождался — сообщение не набирается, человек получает причину и текст сообщения.
 */
export class SelfReset {
  static readonly POLL_MS = 250;
  /** Пауза между завершением команды и набором сообщения: поле ввода успевает стать готовым. */
  static readonly SETTLE_MS = 1_000;
  /** Команды, конец которых виден по `SessionStart`: команда → `source`. */
  private static readonly SESSION_SOURCES: Readonly<Record<string, string>> = {
    '/clear': 'clear',
    '/compact': 'compact',
  };
  private readonly never = new AbortController().signal;

  constructor(private readonly deps: SelfResetDeps) {}

  async run(plan: SelfResetPlan): Promise<SelfResetOutcome> {
    try {
      await (plan.delayMs !== undefined ? this.byDelay(plan, plan.delayMs) : this.byHooks(plan));
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.report(plan, reason);
      return { ok: false, reason };
    }
  }

  private async byDelay(plan: SelfResetPlan, delayMs: number): Promise<void> {
    await this.deps.terminal.send(plan.command);
    if (plan.message === undefined) return;
    await this.deps.clock.sleep(delayMs, this.never);
    await this.deps.terminal.send(plan.message);
  }

  private async byHooks(plan: SelfResetPlan): Promise<void> {
    const seconds = Math.round(plan.timeoutMs / 1_000);
    if (!(await this.waitFor('Stop', this.deps.clock.now(), plan.timeoutMs)))
      throw new Error(`ход не закончился за ${seconds} с (нет сигнала хука Stop — настроен ли он?)`);
    const typedAt = this.deps.clock.now();
    await this.deps.terminal.send(plan.command);
    const source = SelfReset.SESSION_SOURCES[plan.command.split(/\s/, 1)[0] ?? ''];
    if (source && !(await this.waitFor('SessionStart', typedAt, plan.timeoutMs, source)))
      throw new Error(
        `${plan.command} не завершилась за ${seconds} с (нет сигнала хука SessionStart — настроен ли он?)`,
      );
    if (plan.message === undefined) return;
    await this.deps.clock.sleep(SelfReset.SETTLE_MS, this.never);
    await this.deps.terminal.send(plan.message);
  }

  /** Ждать метку события не раньше `since` (и с `source`, если задан); к сроку нет — `false`. */
  private async waitFor(event: HookEvent, since: number, timeoutMs: number, source?: string): Promise<boolean> {
    const deadline = this.deps.clock.now() + timeoutMs;
    for (;;) {
      const signal = this.deps.signals.last(this.deps.pane, event, since);
      if (signal && (source === undefined || signal.source === source)) return true;
      if (this.deps.clock.now() >= deadline) return false;
      await this.deps.clock.sleep(SelfReset.POLL_MS, this.never);
    }
  }

  /** Сбой — человеку: что не вышло и что агент хотел набрать (можно ввести вручную). Сбой уведомления не роняет. */
  private async report(plan: SelfResetPlan, reason: string): Promise<void> {
    const text = [
      `⚠️ Самосброс не выполнен: ${reason}.`,
      `Команда: \`${plan.command}\``,
      ...(plan.message !== undefined ? ['Сообщение агента для продолжения:', plan.message] : []),
    ].join('\n');
    try {
      await this.deps.notify(text);
    } catch {
      // Человек не узнает; причина остаётся в выводе и логе процесса.
    }
  }
}
