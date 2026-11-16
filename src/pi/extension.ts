import { type BridgeHerald, type PiAgent, PiBridge, type PiBridgeOptions } from './bridge.ts';

/**
 * Минимум API pi (`@earendil-works/pi-coding-agent`, docs/extensions.md), которым пользуется расширение.
 * Свои типы вместо пакета pi: расширению не нужна зависимость.
 */
export interface PiContext {
  mode: 'tui' | 'rpc' | 'json' | 'print';
  cwd: string;
  ui: { notify(message: string, level: 'info' | 'warning' | 'error'): void };
  sessionManager: { getSessionId(): string };
}

/** Контекст команды: только в нём безопасен `newSession` (в обработчике события может зависнуть). */
export interface PiCommandContext extends PiContext {
  waitForIdle(): Promise<void>;
  newSession(): Promise<{ cancelled: boolean }>;
  /** Не ждёт конца сжатия; во время хода агента прерывает его — вызывать после `waitForIdle`. */
  compact(options: { onComplete?: () => void; onError?: (error: Error) => void }): void;
}

export interface PiEvent {
  reason?: string;
}

export interface PiCommand {
  description: string;
  handler(args: string, ctx: PiCommandContext): Promise<void>;
}

export interface PiSendOptions {
  deliverAs?: 'steer' | 'followUp';
  expandPromptTemplates?: boolean;
}

export interface PiApi {
  on(event: string, handler: (event: PiEvent, ctx: PiContext) => unknown): void;
  registerCommand(name: string, command: PiCommand): void;
  sendUserMessage(text: string, options?: PiSendOptions): void;
}

export interface HeraldExtensionDeps {
  /** Клиент herald для сессии pi; нет настроек — исключение. */
  connect(where: { cwd: string; sessionId: string }): BridgeHerald;
  bridge?: Pick<PiBridgeOptions, 'inboxWaitMs' | 'retryDelayMs'>;
}

/**
 * Расширение herald для pi: на время сессии — мост входящих (`PiBridge`), он же пульс.
 * Указание — сообщение пользователя (`steer`: агент занят — после текущих инструментов).
 * `/clear` и `/compact` — свои команды: ждут конца хода, затем новая сессия или сжатие.
 * Экземпляр живёт одну сессию: при `/new`, `/resume`, `/fork`, `/reload` pi создаёт расширение заново.
 */
export class HeraldExtension implements PiAgent {
  /** Режимы с живым человеком; `pi -p` (выжимка chronicle и т.п.) — без herald. */
  static readonly MODES: readonly PiContext['mode'][] = ['tui', 'rpc'];
  /** Команда из Telegram → команда расширения. */
  static readonly COMMANDS: Readonly<Record<string, string>> = {
    '/clear': 'herald-clear',
    '/compact': 'herald-compact',
  };

  private bridge: PiBridge | undefined;
  private ui: PiContext['ui'] | undefined;
  /** Идёт сжатие контекста: pi отклоняет сообщения, доставка ждёт. */
  private compaction: { done: Promise<void>; finish: () => void } | undefined;

  constructor(
    private readonly pi: PiApi,
    private readonly deps: HeraldExtensionDeps,
  ) {}

  register(): void {
    const { pi } = this;
    pi.on('session_start', (_event, ctx) => this.start(ctx));
    pi.on('session_shutdown', (event) => this.bridge?.stop({ bye: event.reason !== 'reload' }));
    pi.on('session_before_compact', () => {
      this.compactionStarted();
    });
    pi.on('session_compact', () => this.compactionFinished());
    pi.on('session_compact_failed', () => this.compactionFinished());

    pi.registerCommand('herald-clear', {
      description: 'herald: дождаться конца хода и начать новую сессию (/clear из Telegram)',
      handler: (_args, ctx) =>
        this.guard('/clear', async () => {
          await ctx.waitForIdle();
          const { cancelled } = await ctx.newSession();
          if (cancelled) throw new Error('новую сессию отменило расширение pi');
        }),
    });
    pi.registerCommand('herald-compact', {
      description: 'herald: дождаться конца хода и сжать контекст (/compact из Telegram)',
      handler: (_args, ctx) =>
        this.guard('/compact', async () => {
          await ctx.waitForIdle();
          ctx.compact({ onError: (error) => void this.bridge?.failed('/compact', error) });
        }),
    });
  }

  async say(text: string): Promise<void> {
    await this.compaction?.done;
    this.pi.sendUserMessage(text, { deliverAs: 'steer' });
  }

  async run(command: string): Promise<void> {
    const name = HeraldExtension.COMMANDS[command];
    if (!name) throw new Error('pi не знает этой команды');
    this.pi.sendUserMessage(`/${name}`, { expandPromptTemplates: true });
  }

  private start(ctx: PiContext): void {
    if (!HeraldExtension.MODES.includes(ctx.mode) || this.bridge) return;
    this.ui = ctx.ui;
    let herald: BridgeHerald;
    try {
      herald = this.deps.connect({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
    } catch (error) {
      ctx.ui.notify(`herald отключён: ${(error as Error).message}`, 'warning');
      return;
    }
    this.bridge = new PiBridge({
      herald,
      agent: this,
      log: (message) => this.ui?.notify(message, 'warning'),
      ...this.deps.bridge,
    });
    this.bridge.start();
  }

  /** Сбой команды — человеку в Telegram: он её и отдавал. */
  private async guard(command: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      await this.bridge?.failed(command, error);
    }
  }

  private compactionStarted(): void {
    if (this.compaction) return;
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.compaction = { done, finish };
  }

  private compactionFinished(): void {
    this.compaction?.finish();
    this.compaction = undefined;
  }
}
