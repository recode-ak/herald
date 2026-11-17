import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Clock } from '../app/ports.ts';
import { type TmuxRun, TmuxTerminal } from './tmux.ts';

/** Запуск не удался: каталог не тот, окно закрылось, диалоги не пройдены. */
export class LaunchError extends Error {
  override name = 'LaunchError';
}

export interface AgentLauncherDeps {
  tmux: TmuxRun;
  /** Домашний каталог: запуск — только внутри него. */
  home: string;
  /** Относительный каталог — от этого. */
  cwd: string;
  /** Полный путь к `claude`: окно получает окружение сервера tmux, а не вызывающего. */
  claude: string;
  clock: Clock;
}

export interface LaunchRequest {
  dir: string;
  /** Задача — первым сообщением агенту. */
  prompt?: string;
  tmuxSession: string;
  /** Срок прохождения стартовых диалогов. */
  timeoutMs: number;
}

export interface Launched {
  pane: string;
  window: string;
  dir: string;
}

/**
 * Новое окно агента: Claude Code с каналом herald в окне tmux-сессии; стартовые диалоги проходятся по экрану.
 * Тексты диалогов — Claude Code 2.1.326; сменятся — правятся константы ниже.
 */
export class AgentLauncher {
  static readonly POLL_MS = 500;
  /** Та же клавиша на том же экране — не чаще. */
  static readonly REPEAT_MS = 1_000;
  /** «Доверять ли папке»: по умолчанию выбран «No, exit» — нужен Down. */
  static readonly TRUST_DIALOG = 'Yes, I trust this folder';
  static readonly DEV_CHANNEL_DIALOG = 'I am using this for local development';
  /** Баннер готового окна с каналом. */
  static readonly READY = 'Channels (experimental)';
  private static readonly TAIL_LINES = 10;
  private readonly never = new AbortController().signal;

  constructor(private readonly deps: AgentLauncherDeps) {}

  /** `~/…`, абсолютный или относительный (от `cwd`) → настоящий путь существующего каталога внутри домашнего. */
  resolve(dir: string): string {
    const expanded = dir === '~' ? this.deps.home : dir.startsWith('~/') ? join(this.deps.home, dir.slice(2)) : dir;
    const path = resolve(this.deps.cwd, expanded);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new LaunchError(`нет каталога ${path}`);
    }
    if (!statSync(real).isDirectory()) throw new LaunchError(`${real} — не каталог`);
    const inside = relative(realpathSync(this.deps.home), real);
    if (inside.startsWith('..') || isAbsolute(inside)) throw new LaunchError(`${real} — вне домашнего каталога`);
    return real;
  }

  async launch(request: LaunchRequest): Promise<Launched> {
    const dir = this.resolve(request.dir);
    const command = [
      this.deps.claude,
      // Флаг забирает значения после себя: задача — только после `--`.
      '--dangerously-load-development-channels',
      'server:herald',
      ...(request.prompt !== undefined ? ['--', request.prompt] : []),
    ];
    const name = request.tmuxSession;
    const where = (await this.hasSession(name)) ? ['new-window', '-t', `=${name}:`] : ['new-session', '-s', name];
    const [verb, ...target] = where as [string, ...string[]];
    // Несколько аргументов после `--` tmux запускает без shell: кавычки в задаче не нужны.
    const out = await this.deps.tmux([
      verb,
      '-d',
      '-P',
      '-F',
      '#{pane_id} #{window_id}',
      ...target,
      '-n',
      basename(dir),
      '-c',
      dir,
      '--',
      ...command,
    ]);
    const [pane, window] = (out ?? '').trim().split(' ');
    if (!pane || !window) throw new LaunchError(`tmux не вернул панель окна: «${out ?? ''}»`);
    await this.passDialogs(new TmuxTerminal(pane, this.deps.tmux), request.timeoutMs);
    return { pane, window, dir };
  }

  /** Что нажать на этом экране: курсор на «No, exit» — выбрать «Yes» (Down); на «Yes» или dev-канал — Enter. */
  private static actionFor(screen: string): 'trust-select' | 'trust-confirm' | 'dev-confirm' | undefined {
    if (screen.includes(AgentLauncher.TRUST_DIALOG)) {
      const yes = screen.split('\n').find((line) => line.includes(AgentLauncher.TRUST_DIALOG));
      return yes?.includes('❯') ? 'trust-confirm' : 'trust-select';
    }
    return screen.includes(AgentLauncher.DEV_CHANNEL_DIALOG) ? 'dev-confirm' : undefined;
  }

  private async hasSession(name: string): Promise<boolean> {
    try {
      await this.deps.tmux(['has-session', '-t', `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Пройти «доверять папке» и «dev-канал», дождаться баннера канала. Клавиша — по состоянию экрана
   * (где курсор), поэтому повтор безопасен: окно на старте может ещё не принимать ввод и потерять нажатие.
   * Та же клавиша на том же экране — не чаще `REPEAT_MS`; экран сменился — сразу.
   */
  private async passDialogs(terminal: TmuxTerminal, timeoutMs: number): Promise<void> {
    const deadline = this.deps.clock.now() + timeoutMs;
    let last: { action: string; at: number } | undefined;
    let screen = '';
    for (;;) {
      try {
        screen = await terminal.screen();
      } catch {
        throw new LaunchError(`окно ${terminal.pane} закрылось до готовности (claude вышел)`);
      }
      if (screen.includes(AgentLauncher.READY)) return;
      const action = AgentLauncher.actionFor(screen);
      const now = this.deps.clock.now();
      if (action && !(last?.action === action && now - last.at < AgentLauncher.REPEAT_MS)) {
        await terminal.press(action === 'trust-select' ? 'Down' : 'Enter');
        last = { action, at: now };
      }
      if (now >= deadline) break;
      await this.deps.clock.sleep(AgentLauncher.POLL_MS, this.never);
    }
    const tail = screen
      .split('\n')
      .filter((line) => line.trim())
      .slice(-AgentLauncher.TAIL_LINES)
      .join('\n');
    throw new LaunchError(`окно ${terminal.pane} не готово за ${Math.round(timeoutMs / 1_000)} с; на экране:\n${tail}`);
  }
}
