import type { AskItem, AskRequest, ItemAnswerRequest } from '../client/client.ts';
import type { InboxKind } from '../domain/inbox.ts';
import type { Choice } from '../domain/question.ts';
import type { InboxItemWire, QuestionWire } from '../http/wire.ts';
import type { ChannelHerald } from './channel.ts';

/** Клиент herald в памяти для тестов канала: запоминает вызовы, выдаёт положенные входящие. */
export class FakeHerald implements ChannelHerald {
  readonly notified: string[] = [];
  readonly statuses: string[] = [];
  readonly titles: string[] = [];
  byes = 0;
  readonly asked: AskRequest[] = [];
  readonly decided: { id: string; choice: Choice | readonly ItemAnswerRequest[]; reason: string }[] = [];
  readonly answeredInTerminal: { id: string; choice: Choice | readonly ItemAnswerRequest[] }[] = [];
  /** Аргументы toTerminal. */
  readonly movedToTerminal: (string | undefined)[] = [];
  /** Что вернёт toTerminal. */
  terminalQuestions: QuestionWire[] = [];
  readonly acked: string[] = [];
  /** Сколько раз спрашивали входящие. */
  polls = 0;
  /** Виды из последнего запроса входящих. */
  lastKinds: readonly InboxKind[] = [];
  /** Порядок вызовов ack и bye. */
  readonly calls: string[] = [];
  private queue: InboxItemWire[] = [];
  private failure: string | undefined;
  private wake: (() => void) | undefined;

  /** Следующий вызов упадёт с этим текстом. */
  failNext(message: string): void {
    this.failure = message;
  }

  /** Положить входящие; будит ждущий `inbox`. */
  push(...items: InboxItemWire[]): void {
    this.queue.push(...items);
    this.wake?.();
  }

  async notify(text: string): Promise<void> {
    this.maybeFail();
    this.notified.push(text);
  }

  async status(text: string): Promise<void> {
    this.maybeFail();
    this.statuses.push(text);
  }

  async bye(): Promise<void> {
    this.maybeFail();
    this.byes++;
    this.calls.push('bye');
  }

  async title(text: string): Promise<void> {
    this.maybeFail();
    this.titles.push(text);
  }

  async ask(request: AskRequest): Promise<QuestionWire> {
    this.maybeFail();
    this.asked.push(request);
    const items = 'questions' in request ? request.questions : [request];
    const first = items[0] as AskItem;
    return {
      id: `q_${this.asked.length}`,
      text: first.text,
      options: first.options,
      status: 'open',
      askedAt: 0,
      lateAnswers: [],
      items: items.map((i) => ({ text: i.text, options: i.options, lateAnswers: [] })),
    };
  }

  async answered(id: string, choice: Choice | readonly ItemAnswerRequest[]): Promise<QuestionWire> {
    this.maybeFail();
    this.answeredInTerminal.push({ id, choice });
    return { id, text: '', options: [], status: 'answered', askedAt: 0, lateAnswers: [], items: [] };
  }

  async decide(id: string, choice: Choice | readonly ItemAnswerRequest[], reason: string): Promise<QuestionWire> {
    this.maybeFail();
    this.decided.push({ id, choice, reason });
    return { id, text: '', options: [], status: 'decided', askedAt: 0, lateAnswers: [], items: [] };
  }

  async toTerminal(id?: string): Promise<QuestionWire[]> {
    this.maybeFail();
    this.movedToTerminal.push(id);
    return this.terminalQuestions;
  }

  /** Непрочитанные (`kinds` — только этих видов); если их нет — ждёт `push` не дольше 20 мс (короткий long poll). */
  async inbox(_waitMs?: number, kinds: readonly InboxKind[] = []): Promise<InboxItemWire[]> {
    this.polls++;
    this.lastKinds = kinds;
    this.maybeFail();
    const pending = () => this.queue.filter((i) => kinds.length === 0 || kinds.includes(i.kind));
    if (pending().length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    return pending();
  }

  async ack(ids: readonly string[]): Promise<string[]> {
    this.maybeFail();
    this.queue = this.queue.filter((i) => !ids.includes(i.id));
    this.acked.push(...ids);
    this.calls.push('ack');
    return [...ids];
  }

  private maybeFail(): void {
    if (this.failure === undefined) return;
    const message = this.failure;
    this.failure = undefined;
    throw new Error(message);
  }
}
