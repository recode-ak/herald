import type { Access } from '../domain/access.ts';
import { DomainError } from '../domain/errors.ts';
import type { InboxItem, InboxKind } from '../domain/inbox.ts';
import { type Choice, type ItemAnswer, type ItemDraft, Question } from '../domain/question.ts';
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
  /** Пояс, в котором человеку показано время (срок вопроса). */
  timeZone: string;
}

/** Одиночный вопрос (поля пункта) или пачка (`items`); `timeoutMs` — на весь вопрос. */
export type AskInput = (ItemDraft | { items: ItemDraft[] }) & {
  /** Сколько агент ждёт, прежде чем решить сам; без него решать будет нельзя. */
  timeoutMs?: number | undefined;
};

/** Сценарии агента: уведомление, вопрос, решение, статус, входящие. Каждое обращение отмечает сессию активной. */
export class AgentService {
  private readonly notices: Notices;

  constructor(private readonly deps: AgentDeps) {
    this.notices = new Notices(deps.store, deps.telegram, deps.timeZone);
  }

  async notify(caller: Caller, text: string): Promise<void> {
    const body = text.trim();
    if (!body) throw new DomainError('текст уведомления пуст');
    const session = this.enter(caller);
    const chatId = this.deps.access.chatIdOf(caller.person);
    const messageId = await this.deps.telegram.send({
      chatId,
      text: Messages.notify(session, body),
      html: Messages.notifyHtml(session, body),
    });
    this.deps.store.saveLink({ chatId, messageId, sessionKey: session.key });
  }

  /** Вопрос или пачка: человеку уходит первый пункт, следующие — по мере ответов. */
  async ask(caller: Caller, input: AskInput): Promise<Question> {
    const session = this.enter(caller);
    const question = Question.ask(
      { ...input, id: this.deps.ids.next('q'), sessionKey: session.key, person: caller.person },
      this.deps.clock.now(),
    );
    for (let n = 1; n <= question.items.length; n++) {
      for (const button of Messages.questionButtons(question, n).flat()) {
        if (Buffer.byteLength(button.data) > Messages.CALLBACK_MAX_BYTES) {
          throw new DomainError(`id варианта слишком длинный: «${button.data}»`);
        }
      }
    }
    const chatId = this.deps.access.chatIdOf(caller.person);
    // Вопрос сохраняется после отправки: сбой Telegram его не оставит.
    const messageId = await this.deps.telegram.send({
      chatId,
      text: Messages.question(question, session, this.deps.timeZone),
      html: Messages.questionHtml(question, session, this.deps.timeZone),
      buttons: Messages.questionButtons(question),
    });
    this.deps.store.transaction(() => {
      this.deps.store.saveQuestion(question);
      this.deps.store.saveLink({
        chatId,
        messageId,
        sessionKey: session.key,
        questionId: question.id,
        ...(question.isBatch && { item: 1 }),
      });
    });
    return question;
  }

  /**
   * Человек ответил в терминале агента: пункты закрыты его ответами, сообщения перерисованы без кнопок.
   * Во входящие ответ не попадает — агент его уже знает.
   */
  async answered(caller: Caller, questionId: string, answers: Choice | readonly ItemAnswer[]): Promise<Question> {
    const session = this.enter(caller);
    const question = this.ownQuestion(caller, questionId);
    question.answerInTerminal(answers, this.deps.clock.now());
    this.deps.store.saveQuestion(question);
    this.deps.waiter.notify(Waiter.questionTopic(questionId));
    await this.notices.refreshQuestion(question, session);
    await this.notices.advance(question, session, this.deps.access.chatIdOf(caller.person));
    return question;
  }

  /**
   * Решение агента по неотвеченным пунктам (по таймауту; вопрос без таймаута решает только человек).
   * Сообщения пунктов обновляются, кнопки остаются для переигрывания; пункты, которых человек не видел, — итогом.
   */
  async decide(
    caller: Caller,
    questionId: string,
    answers: Choice | readonly ItemAnswer[],
    reason: string,
  ): Promise<Question> {
    const session = this.enter(caller);
    const question = this.ownQuestion(caller, questionId);
    question.decide(answers, reason, this.deps.clock.now());
    this.deps.store.saveQuestion(question);
    await this.notices.refreshQuestion(question, session);
    await this.notices.decidedRest(question, session, this.deps.access.chatIdOf(caller.person));
    return question;
  }

  /** Статус сессии. В Telegram не отправляется. */
  async status(caller: Caller, text: string): Promise<void> {
    const session = this.enter(caller);
    session.setStatus(text, this.deps.clock.now());
    this.deps.store.saveSession(session);
  }

  /**
   * Окно агента закрывается: сессия не на связи до следующего обращения.
   * Непрочитанные указания человеку перечисляются: новое окно их не получит (у него другой ключ).
   */
  async bye(caller: Caller): Promise<void> {
    const { store, telegram, access, clock } = this.deps;
    const session = this.enter(caller);
    session.close(clock.now());
    store.saveSession(session);
    const unread = store
      .inbox(session.key)
      .pending()
      .filter((i) => i.kind === 'directive');
    if (unread.length === 0) return;
    await telegram.send({
      chatId: access.chatIdOf(caller.person),
      text: Messages.unread(
        session,
        unread.map((i) => i.text),
      ),
    });
  }

  /** Название сессии — в шапке её сообщений. В Telegram отдельно не отправляется. */
  async title(caller: Caller, text: string): Promise<void> {
    const session = this.enter(caller);
    session.setTitle(text, this.deps.clock.now());
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

  /**
   * Ждать входящих до `timeoutMs`: непрочитанные сразу, иначе — первые пришедшие; по таймауту — пусто.
   * `kinds` — только этих видов (пусто — все): расширение pi не берёт ответы, их ждёт `herald ask`.
   */
  async awaitInbox(caller: Caller, timeoutMs: number, kinds: readonly InboxKind[] = []): Promise<InboxItem[]> {
    const session = this.enter(caller);
    const deadline = this.deps.clock.now() + timeoutMs;
    for (;;) {
      const pending = this.deps.store.inbox(session.key).pending(kinds);
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
