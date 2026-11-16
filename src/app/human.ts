import type { Access, PersonId } from '../domain/access.ts';
import { DomainError } from '../domain/errors.ts';
import { InboxItem } from '../domain/inbox.ts';
import type { Choice, Question } from '../domain/question.ts';
import type { Session } from '../domain/session.ts';
import { Messages } from './messages.ts';
import { Notices } from './notices.ts';
import { type Clock, ForbiddenError, type Ids, NotFoundError } from './ports.ts';
import type { Store } from './store.ts';
import type { TelegramPort, TelegramUpdate } from './telegram.ts';
import { Waiter } from './waiter.ts';

export interface HumanDeps {
  store: Store;
  telegram: TelegramPort;
  access: Access;
  clock: Clock;
  ids: Ids;
  waiter: Waiter;
  /** Сессия активна, пока с последнего обращения агента прошло не больше окна. */
  activeWindowMs: number;
}

type MessageUpdate = Extract<TelegramUpdate, { kind: 'message' }>;
type CallbackUpdate = Extract<TelegramUpdate, { kind: 'callback' }>;

/**
 * Сценарии человека — разбор апдейтов Telegram: кнопки вопросов, reply, `/sessions`, `/status`.
 * Принимаются только апдейты chat_id из доступа и только по сессиям своего человека.
 */
export class HumanService {
  private readonly notices: Notices;

  constructor(private readonly deps: HumanDeps) {
    this.notices = new Notices(deps.store, deps.telegram);
  }

  async handle(update: TelegramUpdate): Promise<void> {
    const person = this.deps.access.personByChatId(update.chatId);
    if (update.kind === 'callback') {
      if (!person) return this.deps.telegram.answerCallback(update.callbackId);
      const text = await this.guard(() => this.onCallback(person, update));
      return this.deps.telegram.answerCallback(update.callbackId, text);
    }
    if (!person) return;
    const text = await this.guard(() => this.onMessage(person, update));
    if (text) await this.deps.telegram.send({ chatId: update.chatId, text, replyTo: update.messageId });
  }

  /** Ошибка сценария → текст для человека. */
  private async guard(fn: () => Promise<string | undefined>): Promise<string | undefined> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ForbiddenError) return `⛔ ${error.message}`;
      if (error instanceof DomainError || error instanceof NotFoundError) return `⚠️ ${error.message}`;
      throw error;
    }
  }

  private async onCallback(person: PersonId, update: CallbackUpdate): Promise<string> {
    const [kind, id, ...rest] = update.data.split(':');
    if (kind === 'a' && id && rest.length > 0) return this.answer(person, id, { option: rest.join(':') }, update);
    if (kind === 'h' && id && rest.length === 0) return this.hold(person, id);
    if (kind === 's' && id && rest.length === 0) return this.select(person, update.chatId, id);
    return '⚠️ кнопка устарела';
  }

  /** Сообщение человека; возвращает ответ бота (или ничего). */
  private async onMessage(person: PersonId, update: MessageUpdate): Promise<string | undefined> {
    const text = update.text.trim();
    const command = text.startsWith('/') ? text.split(/\s/, 1)[0]?.split('@', 1)[0] : undefined;
    if (command === '/sessions') return this.sessionsMenu(person, update.chatId);
    if (command === '/status') return this.statusReport(person, update);
    if (command) return Messages.WHOM;

    if (update.replyTo !== undefined) {
      const link = this.deps.store.link(update.chatId, update.replyTo);
      if (!link) return Messages.WHOM;
      if (link.questionId) {
        await this.answer(person, link.questionId, { text }, update);
        return undefined;
      }
      return this.directive(person, link.sessionKey, text, update);
    }

    const target = this.deps.store.chatTarget(update.chatId);
    if (!target) return Messages.WHOM;
    this.deps.store.setChatTarget(update.chatId, undefined);
    return this.directive(person, target, text, update);
  }

  /** Ответ на вопрос: кнопкой (`option`) или reply (`text`). Поздний — в `late-answer`. */
  private async answer(
    person: PersonId,
    questionId: string,
    choice: Choice,
    update: MessageUpdate | CallbackUpdate,
  ): Promise<string> {
    const { store, clock } = this.deps;
    const question = this.ownQuestion(person, questionId);
    const session = this.ownSession(person, question.sessionKey);
    const outcome = question.answer(choice, clock.now());
    const resolution = outcome === 'answer' ? question.resolution : question.lateAnswers.at(-1);
    if (!resolution) throw new DomainError(`вопрос ${questionId}: ответ не записан`);
    const item = InboxItem.create(
      {
        id: this.deps.ids.next('i'),
        sessionKey: session.key,
        person,
        kind: outcome === 'answer' ? 'answer' : 'late-answer',
        text: Messages.answerText(question, resolution),
        questionId,
        ...(resolution.option !== undefined && { option: resolution.option }),
      },
      clock.now(),
    );
    store.transaction(() => {
      store.saveQuestion(question);
      store.saveInboxItem(item);
    });
    await this.notices.refreshQuestion(question, session);
    // Кнопка: перерисованный вопрос и всплывающий ответ — уже квитанция. Текст reply — реакция на нём.
    const warning = Messages.offline(session, clock.now());
    if (update.kind === 'message') {
      await this.notices.queued(item, session, update.chatId, update.messageId);
      if (warning) await this.notices.warn(warning, update.chatId, update.messageId);
    }
    // Будим после реакции «в ящике»: иначе агент прочтёт раньше, и «прочитано» её затрёт не по порядку.
    this.deps.waiter.notify(Waiter.questionTopic(questionId));
    this.deps.waiter.notify(Waiter.sessionTopic(session.key));
    const label = resolution.option ?? 'ответ принят';
    const text = outcome === 'answer' ? `Принят ${label}` : `Переигрывание вопроса ${questionId}: ${label}`;
    return warning && update.kind === 'callback' ? `${text} · ${warning}` : text;
  }

  private async hold(person: PersonId, questionId: string): Promise<string> {
    const question = this.ownQuestion(person, questionId);
    question.hold(this.deps.clock.now());
    this.deps.store.saveQuestion(question);
    await this.notices.refreshQuestion(question, this.ownSession(person, question.sessionKey));
    return 'Агент подождёт';
  }

  /** Кнопка сессии в `/sessions`: следующий текст чата — указание ей. */
  private async select(person: PersonId, chatId: number, token: string): Promise<string> {
    const session = this.deps.store.sessionsOf(person).find((s) => HumanService.sessionToken(s) === token);
    if (!session) throw new ForbiddenError('сессия недоступна');
    this.deps.store.setChatTarget(chatId, session.key);
    await this.deps.telegram.send({ chatId, text: `✍️ Следующее сообщение — указание сессии ${session.project}.` });
    return `Адресат: ${session.project}`;
  }

  private async directive(
    person: PersonId,
    sessionKey: string,
    text: string,
    update: MessageUpdate,
  ): Promise<undefined> {
    const session = this.ownSession(person, sessionKey);
    const item = InboxItem.create(
      { id: this.deps.ids.next('i'), sessionKey, person, kind: 'directive', text },
      this.deps.clock.now(),
    );
    this.deps.store.saveInboxItem(item);
    await this.notices.queued(item, session, update.chatId, update.messageId);
    const warning = Messages.offline(session, this.deps.clock.now());
    if (warning) await this.notices.warn(warning, update.chatId, update.messageId);
    this.deps.waiter.notify(Waiter.sessionTopic(sessionKey));
    return undefined;
  }

  private async sessionsMenu(person: PersonId, chatId: number): Promise<undefined> {
    const sessions = this.activeSessions(person);
    if (sessions.length === 0) {
      await this.deps.telegram.send({ chatId, text: Messages.NO_SESSIONS });
      return undefined;
    }
    const now = this.deps.clock.now();
    const text = [
      'Активные сессии:',
      ...sessions.map((s) => Messages.sessionLine(s, now)),
      '',
      'Выбери адресата указания.',
    ];
    await this.deps.telegram.send({
      chatId,
      text: text.join('\n'),
      buttons: sessions.map((s) => [{ text: Messages.sessionButton(s), data: `s:${HumanService.sessionToken(s)}` }]),
    });
    return undefined;
  }

  private statusReport(person: PersonId, update: MessageUpdate): string {
    const now = this.deps.clock.now();
    const link = update.replyTo !== undefined ? this.deps.store.link(update.chatId, update.replyTo) : undefined;
    const sessions = link ? [this.ownSession(person, link.sessionKey)] : this.activeSessions(person);
    if (sessions.length === 0) return Messages.NO_SESSIONS;
    return sessions.map((s) => Messages.statusLine(s, now)).join('\n');
  }

  private activeSessions(person: PersonId): Session[] {
    const now = this.deps.clock.now();
    return this.deps.store.sessionsOf(person).filter((s) => s.isActive(now, this.deps.activeWindowMs));
  }

  private ownQuestion(person: PersonId, questionId: string): Question {
    const question = this.deps.store.question(questionId);
    if (!question) throw new NotFoundError(`вопроса ${questionId} нет`);
    if (question.person !== person) throw new ForbiddenError(`вопрос ${questionId} недоступен`);
    return question;
  }

  private ownSession(person: PersonId, sessionKey: string): Session {
    const session = this.deps.store.session(sessionKey);
    if (!session) throw new NotFoundError(`сессии ${sessionKey} нет`);
    if (session.person !== person) throw new ForbiddenError('сессия недоступна');
    return session;
  }

  /** Короткий id сессии для callback_data (ключ может быть длиннее 64 байт). */
  private static sessionToken(session: Session): string {
    return Bun.hash(session.key).toString(36);
  }
}
