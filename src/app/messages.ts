import type { Question, Resolution } from '../domain/question.ts';
import type { Session } from '../domain/session.ts';
import { Markup } from './markup.ts';
import type { Keyboard } from './telegram.ts';

/** Как оформить части сообщения: обычный текст (запасной) или HTML Telegram. */
interface Style {
  /** Текст агента: Markdown → разметка. */
  markdown(text: string): string;
  /** Служебный текст herald: только экранирование. */
  plain(text: string): string;
  bold(html: string): string;
  italic(html: string): string;
}

const PLAIN: Style = { markdown: (t) => t, plain: (t) => t, bold: (t) => t, italic: (t) => t };
const HTML: Style = {
  markdown: (t) => Markup.markdown(t),
  plain: (t) => Markup.escape(t),
  bold: (t) => `<b>${t}</b>`,
  italic: (t) => `<i>${t}</i>`,
};

/**
 * Тексты и кнопки сообщений бота. Сообщения агента — в двух видах: HTML (основной, `parse_mode: HTML`)
 * и обычный текст (запасной, если Telegram не разобрал разметку; его же видят тесты).
 */
// biome-ignore lint/complexity/noStaticOnlyClass: правило проекта — класс с зоной ответственности вместо россыпи функций
export class Messages {
  static readonly CALLBACK_MAX_BYTES = 64;

  static header(session: Session): string {
    return `[${session.host} · ${session.label}]`;
  }

  static notify(session: Session, text: string): string {
    return Messages.notifyIn(PLAIN, session, text);
  }

  static notifyHtml(session: Session, text: string): string {
    return Messages.notifyIn(HTML, session, text);
  }

  /** Текст вопроса с текущим состоянием: срок, решение, переигрывания. `timeZone` — пояс, в котором показан срок. */
  static question(question: Question, session: Session, timeZone: string): string {
    return Messages.questionIn(PLAIN, question, session, timeZone);
  }

  static questionHtml(question: Question, session: Session, timeZone: string): string {
    return Messages.questionIn(HTML, question, session, timeZone);
  }

  private static notifyIn(style: Style, session: Session, text: string): string {
    return `${style.bold(style.plain(Messages.header(session)))}\n${style.markdown(text)}`;
  }

  private static questionIn(style: Style, question: Question, session: Session, timeZone: string): string {
    const lines = [
      style.bold(style.plain(Messages.header(session))),
      `❓ ${style.bold(style.markdown(question.text))}`,
    ];
    if (question.options.length > 0) {
      lines.push(
        '',
        ...question.options.map(
          (o) => `${style.bold(style.plain(o.id))}: ${style.markdown(o.text)}${Messages.star(question, o.id)}`,
        ),
      );
    }
    const hint =
      question.options.length > 0 ? 'Ответь кнопкой или reply на это сообщение.' : 'Ответь reply на это сообщение.';
    lines.push('', style.italic(hint));
    let text = lines.join('\n');
    const wait = Messages.waiting(question, timeZone);
    if (wait) text += `\n\n${wait}`;
    const r = question.resolution;
    if (r?.by === 'agent') {
      const replay = Messages.humanAnswered(question) ? '' : ' Кнопки — чтобы переиграть.';
      text += `\n\n🤖 ${style.plain(`${Messages.choice(r)}${r.reason ? ` ${r.reason}` : ''}`)}.${replay}`;
    } else if (r?.by === 'human') {
      text += `\n\n👤 ${style.plain(Messages.choice(r))}.`;
    }
    for (const late of question.lateAnswers) text += `\n🔁 Переигрывание: ${style.plain(Messages.choice(late))}.`;
    return text;
  }

  /** Сколько ждёт агент — пока вопрос открыт: срок, «Жди меня» или без ограничения. */
  private static waiting(question: Question, timeZone: string): string | undefined {
    if (question.status !== 'open') return undefined;
    if (question.heldAt !== undefined) return '⏸ Агент ждёт твоего ответа.';
    const deadline = question.deadlineAt;
    if (deadline === undefined) return '⏳ Время не ограничено: агент ждёт твоего ответа.';
    const span = Messages.span(deadline - question.askedAt);
    return `⏳ На раздумье ${span} — до ${Messages.clock(deadline, question.askedAt, timeZone)}, потом агент решит сам.`;
  }

  /** Длительность: «45 с», «1 мин 30 с», «1 ч 30 мин» (от часа — без секунд). */
  static span(ms: number): string {
    const total = Math.ceil(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const parts = [hours && `${hours} ч`, minutes && `${minutes} мин`, !hours && seconds && `${seconds} с`];
    return parts.filter(Boolean).join(' ') || '0 с';
  }

  /** Время `at` в поясе; другой день, чем `since`, — с датой: «05:03», «02.01 05:00». */
  private static clock(at: number, since: number, timeZone: string): string {
    const time = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' }).format(at);
    const day = new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit' });
    return day.format(at) === day.format(since) ? time : `${day.format(at)} ${time}`;
  }

  /**
   * Кнопки вопроса. Ответил человек (в том числе переигрыванием) — кнопок нет, переиграть можно reply.
   * Иначе — варианты (после решения агента — для переигрывания) и «Жди меня», пока вопрос открыт, не удержан
   * и задан с таймаутом (без таймаута агент и так ждёт: по кнопке видно, решит ли он сам).
   */
  static questionButtons(question: Question): Keyboard {
    if (Messages.humanAnswered(question)) return [];
    const options = question.options.map((o) => [
      { text: `${o.id}${Messages.star(question, o.id)}`, data: `a:${question.id}:${o.id}` },
    ]);
    const canHold = question.status === 'open' && question.heldAt === undefined && question.deadlineAt !== undefined;
    return canHold ? [...options, [{ text: 'Жди меня', data: `h:${question.id}` }]] : options;
  }

  private static humanAnswered(question: Question): boolean {
    return question.resolution?.by === 'human' || question.lateAnswers.length > 0;
  }

  /** Реакция на сообщение человека: входящее в ящике сессии. */
  static readonly INBOX_QUEUED = '✍';
  /** Реакция на сообщение человека: агент прочитал. */
  static readonly INBOX_READ = '👀';

  /** Строка `/sessions` (там только сессии на связи): имя и последний статус. */
  static sessionLine(session: Session, now: number): string {
    const status = session.status ? ` — ${session.status.text} (${Messages.ago(session.status.at, now)})` : '';
    return `${session.host} · ${session.label}${status}`;
  }

  /** Строка `/status`: последний статус с давностью. */
  static statusLine(session: Session, now: number): string {
    const status = session.status
      ? `${session.status.text} (${Messages.ago(session.status.at, now)})`
      : `статуса нет (${Messages.ago(session.lastSeenAt, now)})`;
    return `${Messages.mark(session, now)} ${session.host} · ${session.label} — ${status}`;
  }

  /** Предупреждение: входящее для сессии не на связи (`undefined` — на связи). */
  static offline(session: Session, now: number): string | undefined {
    if (session.isOnline(now)) return undefined;
    return `⚠️ ${session.label} не на связи (${Messages.away(session, now)})`;
  }

  /** Длина указания в списке непрочитанных при закрытии сессии. */
  static readonly UNREAD_PREVIEW = 200;

  /** Сессия закрылась, не прочитав указания. */
  static unread(session: Session, texts: readonly string[]): string {
    const preview = (t: string) =>
      t.length > Messages.UNREAD_PREVIEW ? `${t.slice(0, Messages.UNREAD_PREVIEW - 1)}…` : t;
    return [`⚠️ ${session.label} закрыта, указания не прочитаны:`, ...texts.map((t) => `• ${preview(t)}`)].join('\n');
  }

  static offlineNotice(warning: string): string {
    return `${warning} — прочтёт, когда подключится.`;
  }

  private static mark(session: Session, now: number): string {
    return session.isOnline(now) ? '🟢' : '⚪';
  }

  private static away(session: Session, now: number): string {
    return session.closedAt !== undefined
      ? `закрыта ${Messages.ago(session.closedAt, now)}`
      : Messages.ago(session.lastSeenAt, now);
  }

  static sessionButton(session: Session): string {
    return `${session.label} · ${session.host}`;
  }

  static readonly NO_SESSIONS = 'Сессий на связи нет.';
  static readonly UNKNOWN_COMMAND = 'Неизвестная команда. Есть: /sessions, /status, /clear, /compact.';
  static readonly WHOM = 'Кому? Ответь reply на сообщение сессии или выбери адресата в /sessions.';

  static ago(at: number, now: number): string {
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ч назад`;
    return `${Math.floor(hours / 24)} дн назад`;
  }

  /** Текст ответа во входящих: вариант с подписью или свободный текст. */
  static answerText(question: Question, r: Resolution): string {
    if (r.option === undefined) return r.text ?? '';
    const option = question.options.find((o) => o.id === r.option);
    return option ? `${option.id}: ${option.text}` : r.option;
  }

  private static choice(r: Resolution): string {
    return r.option !== undefined ? `Принят ${r.option}` : `Принято «${r.text}»`;
  }

  private static star(question: Question, optionId: string): string {
    return question.recommended === optionId ? ' ⭐' : '';
  }
}
