import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** События хуков Claude Code, которые ждёт самосброс. */
export type HookEvent = 'Stop' | 'SessionStart';

/** Сигнал хука: `Stop` — ход закончен; `SessionStart` — разговор начат (`source`: startup, resume, clear, compact). */
export interface HookSignal {
  event: HookEvent;
  source?: string;
  /** Когда записан, мс эпохи. */
  at: number;
}

type Env = Record<string, string | undefined>;

const EVENTS: readonly string[] = ['Stop', 'SessionStart'] satisfies readonly HookEvent[];

/**
 * Метки хуков по панелям tmux: хук окна (`herald hook`) пишет, самосброс (`SelfReset`) читает.
 * Файл на панель и событие — `<панель без %>.<событие>.json`; новый сигнал заменяет прежний.
 */
export class HookSignals {
  constructor(private readonly dir: string) {}

  /** `$XDG_STATE_HOME/herald/hooks`, иначе `~/.local/state/herald/hooks`. */
  static dirOf(env: Env): string {
    const state = env.XDG_STATE_HOME?.trim() || join(env.HOME ?? '', '.local', 'state');
    return join(state, 'herald', 'hooks');
  }

  /** JSON хука из stdin → сигнал; чужое событие или не JSON-объект — `undefined`. */
  static parse(raw: string, now: number): HookSignal | undefined {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const { hook_event_name: event, source } = value as Record<string, unknown>;
    if (typeof event !== 'string' || !EVENTS.includes(event)) return undefined;
    return { event: event as HookEvent, ...(typeof source === 'string' && { source }), at: now };
  }

  record(pane: string, signal: HookSignal): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(pane, signal.event);
    // Через временный файл: читатель не увидит полузаписанный JSON.
    writeFileSync(`${file}.tmp`, JSON.stringify(signal));
    renameSync(`${file}.tmp`, file);
  }

  /** Последний сигнал события панели, если он записан не раньше `since`. */
  last(pane: string, event: HookEvent, since: number): HookSignal | undefined {
    let signal: HookSignal;
    try {
      signal = JSON.parse(readFileSync(this.file(pane, event), 'utf8')) as HookSignal;
    } catch {
      return undefined;
    }
    return signal.at >= since ? signal : undefined;
  }

  private file(pane: string, event: HookEvent): string {
    return join(this.dir, `${pane.replace(/^%/, '')}.${event}.json`);
  }
}
