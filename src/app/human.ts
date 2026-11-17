import type { Access, PersonId } from '../domain/access.ts';
import { DomainError } from '../domain/errors.ts';
import { InboxItem, type InboxKind } from '../domain/inbox.ts';
import type { Choice, Question, Resolution } from '../domain/question.ts';
import type { Session } from '../domain/session.ts';
import { Messages } from './messages.ts';
import { NewWindowBot } from './new-window.ts';
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
  /** Пояс, в котором человеку показано время (срок вопроса). */
  timeZone: string;
}

type MessageUpdate = Extract<TelegramUpdate, { kind: 'message' }>;
type CallbackUpdate = Extract<TelegramUpdate, { kind: 'callback' }>;

/**
 * Сценарии человека — разбор апдейтов Telegram: кнопки вопросов, reply, `/sessions`, `/status`,
 * команды терминала сессии (`/clear`, `/compact`, `/exit`), диалог нового окна (`/new`, `/cancel`).
 * Принимаются только апдейты chat_id из доступа и только по сессиям своего человека.
 */
export class HumanService {
  private readonly notices: Notices;
  private readonly newWindow: NewWindowBot;

  constructor(private readonly deps: HumanDeps) {
    this.notices = new Notices(deps.store, deps.telegram, deps.timeZone);
    this.newWindow = new NewWindowBot(deps);
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
    const questionKinds = ['a', 'b', 'h', 't'];
    if (kind && questionKinds.includes(kind) && id && !this.deps.store.question(id)) return Messages.QUESTION_GONE;
    if (kind === 'a' && id && rest.length > 0) return this.answer(person, id, { option: rest.join(':') }, update);
    if (kind === 'b' && id && rest.length > 1) {
      const n = Number(rest[0]);
      return this.answer(person, id, { option: rest.slice(1).join(':') }, update, n);
    }
    if (kind === 'h' && id && rest.length === 0) return this.hold(person, id);
    if (kind === 't' && id && rest.length === 0) return this.toTerminal(person, id);
    if (kind === 's' && id && rest.length === 0) return this.select(person, update.chatId, id);
    if (kind === 'n') return this.newWindow.press([id ?? '', ...rest], update);
    return Messages.STALE_BUTTON;
  }

  /** Сообщение человека; возвращает ответ бота (или ничего). */
  private async onMessage(person: PersonId, update: MessageUpdate): Promise<string | undefined> {
    const text = update.text.trim();
    const command = text.startsWith('/') ? text.split(/\s/, 1)[0]?.split('@', 1)[0] : undefined;
    if (command === '/new') return this.newWindow.start(person, update.chatId);
    if (command === '/cancel') return this.newWindow.cancel(update.chatId);
    // Другая команда прерывает диалог `/new` и выполняется как обычно.
    if (command) this.newWindow.drop(update.chatId);
    if (command === '/sessions') return this.sessionsMenu(person, update.chatId);
    if (command === '/status') return this.statusReport(person, update);
    if (command && !InboxItem.isCommand(command)) return Messages.UNKNOWN_COMMAND;

    if (update.replyTo !== undefined) {
      const link = this.deps.store.link(update.chatId, update.replyTo);
      if (!link) return Messages.WHOM;
      if (command) return this.post(person, link.sessionKey, 'command', command, update);
      if (link.questionId) {
        await this.answer(person, link.questionId, { text }, update, link.item ?? 1);
        return undefined;
      }
      return this.post(person, link.sessionKey, 'directive', text, update);
    }

    const dialog = command ? undefined : this.newWindow.active(update.chatId);
    if (dialog) return this.newWindow.input(dialog, update.text, update);

    const target = this.deps.store.chatTarget(update.chatId);
    if (!target) return Messages.WHOM;
    this.deps.store.setChatTarget(update.chatId, undefined);
    return command
      ? this.post(person, target, 'command', command, update)
      : this.post(person, target, 'directive', text, update);
  }

  /**
   * Ответ на пункт `n` вопроса: кнопкой (`option`) или reply (`text`). Отвечены все пункты — `answer` во входящие
   * (у пачки — все ответы одним); иначе — следующий пункт новым сообщением. Ответ на решённый вопрос — `late-answer`.
   */
  private async answer(
    person: PersonId,
    questionId: string,
    choice: Choice,
    update: MessageUpdate | CallbackUpdate,
    n = 1,
  ): Promise<string> {
    const { store, clock } = this.deps;
    const question = this.ownQuestion(person, questionId);
    const session = this.ownSession(person, question.sessionKey);
    const outcome = question.answer(choice, clock.now(), n);
    const resolution = outcome === 'answer' ? question.item(n).resolution : question.item(n).lateAnswers.at(-1);
    if (!resolution) throw new DomainError(`вопрос ${questionId}: ответ не записан`);
    const item = this.answerItem(question, session, outcome, n, resolution);
    store.transaction(() => {
      store.saveQuestion(question);
      if (item) store.saveInboxItem(item);
    });
    await this.notices.refreshQuestion(question, session);
    const next = await this.notices.advance(question, session, update.chatId);
    // Кнопка: перерисованный вопрос и всплывающий ответ — уже квитанция. Текст reply — реакция на нём.
    const warning = Messages.offline(session, clock.now());
    if (update.kind === 'message') {
      if (item) await this.notices.queued(item, session, update.chatId, update.messageId);
      if (warning) await this.notices.warn(warning, update.chatId, update.messageId);
    }
    // Будим после реакции «в ящике»: иначе агент прочтёт раньше, и «прочитано» её затрёт не по порядку.
    this.deps.waiter.notify(Waiter.questionTopic(questionId));
    this.deps.waiter.notify(Waiter.sessionTopic(session.key));
    const label = resolution.option ?? 'ответ принят';
    const more = next !== undefined ? ` · дальше вопрос ${next} из ${question.items.length}` : '';
    const text = outcome === 'answer' ? `Принят ${label}${more}` : `Переигрывание вопроса ${questionId}: ${label}`;
    return warning && update.kind === 'callback' ? `${text} · ${warning}` : text;
  }

  /** Входящее по ответу: поздний — сразу; обычный — когда отвечены все пункты. */
  private answerItem(
    question: Question,
    session: Session,
    outcome: 'answer' | 'late',
    n: number,
    resolution: Resolution,
  ): InboxItem | undefined {
    if (outcome === 'answer' && question.status !== 'answered') return undefined;
    const single = !question.isBatch;
    const text =
      outcome === 'late'
        ? single
          ? Messages.answerText(question, resolution)
          : Messages.itemAnswerText(question, n, resolution)
        : single
          ? Messages.answerText(question, resolution)
          : Messages.answersText(question);
    const option = outcome === 'late' || single ? resolution.option : undefined;
    return InboxItem.create(
      {
        id: this.deps.ids.next('i'),
        sessionKey: session.key,
        person: question.person,
        kind: outcome === 'answer' ? 'answer' : 'late-answer',
        text,
        questionId: question.id,
        ...(option !== undefined && { option }),
      },
      this.deps.clock.now(),
    );
  }

  /** «🖥 В терминал»: неотвеченные пункты агент задаст у себя; бот их больше не присылает. */
  private async toTerminal(person: PersonId, questionId: string): Promise<string> {
    const { store, clock } = this.deps;
    const question = this.ownQuestion(person, questionId);
    const session = this.ownSession(person, question.sessionKey);
    if (question.terminalAt !== undefined) return 'Уже в терминале';
    question.moveToTerminal(clock.now());
    const item = InboxItem.create(
      {
        id: this.deps.ids.next('i'),
        sessionKey: session.key,
        person,
        kind: 'to-terminal',
        text: Messages.toTerminalText(question),
        questionId,
      },
      clock.now(),
    );
    store.transaction(() => {
      store.saveQuestion(question);
      store.saveInboxItem(item);
    });
    await this.notices.refreshQuestion(question, session);
    this.deps.waiter.notify(Waiter.questionTopic(questionId));
    this.deps.waiter.notify(Waiter.sessionTopic(session.key));
    const warning = Messages.offline(session, clock.now());
    return warning ? `Переведено в терминал · ${warning}` : 'Переведено в терминал';
  }

  /** «Жди меня»: вся пачка удержана; агенту — `hold` (один раз), чтобы не ждал отказа `decide`. */
  private async hold(person: PersonId, questionId: string): Promise<string> {
    const { store, clock } = this.deps;
    const question = this.ownQuestion(person, questionId);
    const session = this.ownSession(person, question.sessionKey);
    if (question.heldAt !== undefined) return 'Агент подождёт';
    question.hold(clock.now());
    const item = InboxItem.create(
      {
        id: this.deps.ids.next('i'),
        sessionKey: session.key,
        person,
        kind: 'hold',
        text: Messages.holdText(question),
        questionId,
      },
      clock.now(),
    );
    store.transaction(() => {
      store.saveQuestion(question);
      store.saveInboxItem(item);
    });
    await this.notices.refreshQuestion(question, session);
    this.deps.waiter.notify(Waiter.sessionTopic(session.key));
    return 'Агент подождёт';
  }

  /** Кнопка сессии в `/sessions`: следующий текст чата — указание ей. */
  private async select(person: PersonId, chatId: number, token: string): Promise<string> {
    const session = this.deps.store.sessionsOf(person).find((s) => HumanService.sessionToken(s) === token);
    if (!session) throw new ForbiddenError('сессия недоступна');
    this.newWindow.drop(chatId);
    this.deps.store.setChatTarget(chatId, session.key);
    await this.deps.telegram.send({ chatId, text: `✍️ Следующее сообщение — указание сессии ${session.project}.` });
    return `Адресат: ${session.project}`;
  }

  /** Указание или команда терминала — во входящие сессии. */
  private async post(
    person: PersonId,
    sessionKey: string,
    kind: Extract<InboxKind, 'directive' | 'command'>,
    text: string,
    update: MessageUpdate,
  ): Promise<undefined> {
    const session = this.ownSession(person, sessionKey);
    const item = InboxItem.create(
      { id: this.deps.ids.next('i'), sessionKey, person, kind, text },
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
    const sessions = this.onlineSessions(person);
    if (sessions.length === 0) {
      await this.deps.telegram.send({ chatId, text: Messages.NO_SESSIONS });
      return undefined;
    }
    const now = this.deps.clock.now();
    await this.deps.telegram.send({
      chatId,
      text: Messages.sessions(sessions, now),
      html: Messages.sessionsHtml(sessions, now),
      buttons: sessions.map((s) => [{ text: Messages.sessionButton(s), data: `s:${HumanService.sessionToken(s)}` }]),
    });
    return undefined;
  }

  private statusReport(person: PersonId, update: MessageUpdate): string {
    const now = this.deps.clock.now();
    const link = update.replyTo !== undefined ? this.deps.store.link(update.chatId, update.replyTo) : undefined;
    const sessions = link ? [this.ownSession(person, link.sessionKey)] : this.onlineSessions(person);
    if (sessions.length === 0) return Messages.NO_SESSIONS;
    return sessions.map((s) => Messages.statusLine(s, now)).join('\n');
  }

  /** Сессии с пульсом: закрытые и молчащие дольше `Session.ONLINE_MS` не показываются. */
  private onlineSessions(person: PersonId): Session[] {
    const now = this.deps.clock.now();
    return this.deps.store.sessionsOf(person).filter((s) => s.isOnline(now));
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
