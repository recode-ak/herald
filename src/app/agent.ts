import type { Access } from '../domain/access.ts';
import { DomainError } from '../domain/errors.ts';
import type { InboxItem } from '../domain/inbox.ts';
import { type Choice, Question, type QuestionOption } from '../domain/question.ts';
import { Session } from '../domain/session.ts';
import { Messages } from './messages.ts';
import { Notices } from './notices.ts';
import { type Caller, type Clock, ForbiddenError, type Ids, NotFoundError } from './ports.ts';
import type { Store } from './store.ts';
import type { TelegramPort } from './telegram.ts';
import { Waiter } from './waiter.ts';

export interface AgentDeps {
  store: Store;
  telegram: TelegramPort;
  access: Access;
  clock: Clock;
  ids: Ids;
  waiter: Waiter;
}

export interface AskInput {
  text: string;
  options: QuestionOption[];
  recommended?: string;
}

/** Сценарии агента: уведомление, вопрос, решение, статус, входящие. Каждое обращение отмечает сессию активной. */
export class AgentService {
  private readonly notices: Notices;

  constructor(private readonly deps: AgentDeps) {
    this.notices = new Notices(deps.store, deps.telegram);
  }

  async notify(caller: Caller, text: string): Promise<void> {
    const body = text.trim();
    if (!body) throw new DomainError('текст уведомления пуст');
    const session = this.enter(caller);
    const chatId = this.deps.access.chatIdOf(caller.person);
    const messageId = await this.deps.telegram.send({ chatId, text: Messages.notify(session, body) });
    this.deps.store.saveLink({ chatId, messageId, sessionKey: session.key });
  }

  async ask(caller: Caller, input: AskInput): Promise<Question> {
    const session = this.enter(caller);
    const question = Question.ask(
      { ...input, id: this.deps.ids.next('q'), sessionKey: session.key, person: caller.person },
      this.deps.clock.now(),
    );
    const buttons = Messages.questionButtons(question);
    for (const button of buttons.flat()) {
      if (Buffer.byteLength(button.data) > Messages.CALLBACK_MAX_BYTES) {
        throw new DomainError(`id варианта слишком длинный: «${button.data}»`);
      }
    }
    const chatId = this.deps.access.chatIdOf(caller.person);
    const messageId = await this.deps.telegram.send({ chatId, text: Messages.question(question, session), buttons });
    this.deps.store.transaction(() => {
      this.deps.store.saveQuestion(question);
      this.deps.store.saveLink({ chatId, messageId, sessionKey: session.key, questionId: question.id });
    });
    return question;
  }

  /** Решение агента (по таймауту). Сообщение вопроса обновляется, кнопки остаются для переигрывания. */
  async decide(caller: Caller, questionId: string, choice: Choice, reason: string): Promise<Question> {
    const session = this.enter(caller);
    const question = this.ownQuestion(caller, questionId);
    question.decide(choice, reason, this.deps.clock.now());
    this.deps.store.saveQuestion(question);
    await this.notices.refreshQuestion(question, session);
    return question;
  }

  /** Статус сессии. В Telegram не отправляется. */
  async status(caller: Caller, text: string): Promise<void> {
    const session = this.enter(caller);
    session.setStatus(text, this.deps.clock.now());
    this.deps.store.saveSession(session);
  }

  async inbox(caller: Caller): Promise<InboxItem[]> {
    const session = this.enter(caller);
    return this.deps.store.inbox(session.key).pending();
  }

  /** Подтвердить прочтение. Возвращает id впервые прочитанных; реакция на их сообщениях в Telegram → «прочитано» (👀). */
  async ack(caller: Caller, ids: readonly string[]): Promise<string[]> {
    const session = this.enter(caller);
    const { store } = this.deps;
    const read = store.transaction(() => {
      const items = store.inbox(session.key, ids).ack(ids, this.deps.clock.now());
      for (const item of items) store.saveInboxItem(item);
      return items;
    });
    for (const item of read) await this.notices.read(item);
    return read.map((i) => i.id);
  }

  /**
   * Ждать ответа на вопрос до `timeoutMs`; возвращает вопрос (открытый — по таймауту).
   * Ответ человека, полученный так, отмечается прочитанным — во входящих он не повторится.
   */
  async awaitQuestion(caller: Caller, questionId: string, timeoutMs: number): Promise<Question> {
    const session = this.enter(caller);
    const deadline = this.deps.clock.now() + timeoutMs;
    for (;;) {
      const question = this.ownQuestion(caller, questionId);
      if (question.status !== 'open') {
        const answers = this.deps.store
          .inbox(session.key)
          .pending()
          .filter((i) => i.kind === 'answer' && i.questionId === questionId);
        if (answers.length > 0)
          await this.ack(
            caller,
            answers.map((i) => i.id),
          );
        return question;
      }
      if (!(await this.deps.waiter.wait(Waiter.questionTopic(questionId), deadline - this.deps.clock.now()))) {
        return this.ownQuestion(caller, questionId);
      }
    }
  }

  /** Ждать входящих до `timeoutMs`: непрочитанные сразу, иначе — первые пришедшие; по таймауту — пусто. */
  async awaitInbox(caller: Caller, timeoutMs: number): Promise<InboxItem[]> {
    const session = this.enter(caller);
    const deadline = this.deps.clock.now() + timeoutMs;
    for (;;) {
      const pending = this.deps.store.inbox(session.key).pending();
      if (pending.length > 0) return pending;
      if (!(await this.deps.waiter.wait(Waiter.sessionTopic(session.key), deadline - this.deps.clock.now()))) {
        return [];
      }
    }
  }

  /** Зарегистрировать или отметить активной сессию вызывающего. */
  private enter(caller: Caller): Session {
    const { store, clock } = this.deps;
    const key = Session.keyOf(caller.session);
    const existing = store.session(key);
    if (existing && existing.person !== caller.person) throw new ForbiddenError(`сессия ${key} — другого человека`);
    const session = existing ?? Session.open({ ...caller.session, person: caller.person }, clock.now());
    session.touch(clock.now());
    store.saveSession(session);
    return session;
  }

  private ownQuestion(caller: Caller, questionId: string): Question {
    const question = this.deps.store.question(questionId);
    if (!question) throw new NotFoundError(`вопроса ${questionId} нет`);
    if (question.person !== caller.person) throw new ForbiddenError(`вопрос ${questionId} — другого человека`);
    return question;
  }
}
