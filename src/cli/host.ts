import type { Clock } from '../app/ports.ts';
import { HeraldClientError, type LaunchOutcome } from '../client/client.ts';
import type { LaunchWire } from '../http/wire.ts';
import type { Launched, LaunchRequest } from '../terminal/launcher.ts';

/** Сервер для демона: опрос запусков машины и их итог (`HeraldClient`). */
export interface HostLink {
  hostPoll(waitMs?: number): Promise<LaunchWire[]>;
  hostDone(id: string, outcome: LaunchOutcome): Promise<void>;
}

/** Кто открывает окно агента (`AgentLauncher`). */
export interface WindowLauncher {
  launch(request: LaunchRequest): Promise<Launched>;
}

export interface HostDaemonDeps {
  link: HostLink;
  launcher: WindowLauncher;
  clock: Clock;
  /** Строка журнала (stderr → журнал службы). */
  log: (line: string) => void;
  /** Имя машины — для журнала. */
  name: string;
  tmuxSession: string;
  /** Срок открытия окна (стартовые диалоги). */
  timeoutMs: number;
  /** Пауза перед повтором итога, когда сервер недоступен. */
  retryDelayMs?: number;
}

/**
 * Демон машины (`herald host`): опрос запусков по `/new` → окно агента → итог на сервер. Запуски — по одному.
 * Сбои сети и 5xx при опросе пережидаются; иная ошибка (токен) — выход с кодом 1. Стоп во время опроса — выход
 * сразу; во время запуска — после итогов всех взятых запусков: сервер их больше не выдаст.
 */
export class HostDaemon {
  /** Сколько ждать запусков за один опрос (клиент переподключается внутри). */
  static readonly POLL_MS = 300_000;
  /** Попыток доставить итог, пока сервер недоступен. */
  static readonly DONE_ATTEMPTS = 5;
  private readonly retryDelayMs: number;

  constructor(private readonly deps: HostDaemonDeps) {
    this.retryDelayMs = deps.retryDelayMs ?? 2_000;
  }

  /** До остановки `signal` (код 0) или неустранимой ошибки опроса (код 1). */
  async run(signal: AbortSignal): Promise<number> {
    const { link, log, name, tmuxSession } = this.deps;
    log(`herald host: машина ${name}, окна — в tmux-сессии ${tmuxSession}; жду запусков`);
    const stopped = new Promise<'stop'>((resolve) => {
      if (signal.aborted) resolve('stop');
      signal.addEventListener('abort', () => resolve('stop'), { once: true });
    });
    while (!signal.aborted) {
      let launches: LaunchWire[] | 'stop';
      try {
        launches = await Promise.race([link.hostPoll(HostDaemon.POLL_MS), stopped]);
      } catch (error) {
        if (!HostDaemon.transient(error)) {
          log(`herald host: опрос не удался — ${HostDaemon.message(error)}; выхожу`);
          return 1;
        }
        log(`herald host: ${HostDaemon.message(error)}; продолжаю ждать`);
        continue;
      }
      if (launches === 'stop') break;
      for (const launch of launches) await this.open(launch, signal);
    }
    log('herald host: остановлен');
    return 0;
  }

  private async open(launch: LaunchWire, signal: AbortSignal): Promise<void> {
    const { launcher, log, tmuxSession, timeoutMs } = this.deps;
    log(`herald host: запуск ${launch.id} в ${launch.dir}`);
    let outcome: LaunchOutcome;
    try {
      const { pane, window, dir } = await launcher.launch({
        dir: launch.dir,
        prompt: launch.prompt,
        tmuxSession,
        timeoutMs,
      });
      outcome = { ok: true, text: `${dir} (окно ${window}, панель ${pane})` };
    } catch (error) {
      outcome = { ok: false, text: HostDaemon.message(error) };
    }
    log(`herald host: запуск ${launch.id} — ${outcome.ok ? 'окно открыто' : 'не удался'}: ${outcome.text}`);
    await this.report(launch.id, outcome, signal);
  }

  /** Итог — один раз: повтор только когда сервер недоступен (до него не дошло); ответ с кодом — в журнал. */
  private async report(id: string, outcome: LaunchOutcome, signal: AbortSignal): Promise<void> {
    const { link, clock, log } = this.deps;
    for (let attempt = 1; ; attempt++) {
      try {
        await link.hostDone(id, outcome);
        return;
      } catch (error) {
        const unreachable = error instanceof HeraldClientError && error.status === undefined;
        if (!unreachable || attempt >= HostDaemon.DONE_ATTEMPTS || signal.aborted) {
          log(`herald host: итог не доставлен ${id} — ${HostDaemon.message(error)}`);
          return;
        }
        await clock.sleep(this.retryDelayMs, signal);
      }
    }
  }

  private static transient(error: unknown): boolean {
    return error instanceof HeraldClientError && (error.status === undefined || error.status >= 500);
  }

  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
