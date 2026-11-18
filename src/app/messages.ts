import type { Launch } from '../domain/host.ts';
import type { NewWindowDialog } from '../domain/new-window.ts';
import type { Question, QuestionItem, Resolution } from '../domain/question.ts';
import type { Session } from '../domain/session.ts';
import { Markup } from './markup.ts';
import type { Keyboard } from './telegram.ts';

/** Как показать сообщение пункта: `sent` — последний отправленный пункт пачки. */
export interface QuestionView {
  sent?: number;
}

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

  /**
   * Сообщение пункта `n` вопроса с текущим состоянием: срок, решение, переигрывания. `timeZone` — пояс, в котором
   * показан срок. `view.sent` — последний отправленный пункт: на его сообщении — итог ответов в терминале на остальные.
   */
  static question(question: Question, session: Session, timeZone: string, n = 1, view: QuestionView = {}): string {
    return Messages.questionIn(PLAIN, question, session, timeZone, n, view);
  }

  static questionHtml(question: Question, session: Session, timeZone: string, n = 1, view: QuestionView = {}): string {
    return Messages.questionIn(HTML, question, session, timeZone, n, view);
  }

  /** Итог решения агента по пунктам пачки, которые человек не видел (после `sent`); reply на него — указание. */
  static decidedRest(question: Question, session: Session, sent: number): string {
    return Messages.decidedRestIn(PLAIN, question, session, sent);
  }

  static decidedRestHtml(question: Question, session: Session, sent: number): string {
    return Messages.decidedRestIn(HTML, question, session, sent);
  }

  /** Есть ли что сказать итогом решения агента: неотправленные пункты, решённые агентом. */
  static hasDecidedRest(question: Question, sent: number): boolean {
    return question.items.slice(sent).some((i) => i.resolution?.by === 'agent');
  }

  private static notifyIn(style: Style, session: Session, text: string): string {
    return `${style.bold(style.plain(Messages.header(session)))}\n${style.markdown(text)}`;
  }

  private static questionIn(
    style: Style,
    question: Question,
    session: Session,
    timeZone: string,
    n: number,
    view: QuestionView,
  ): string {
    const item = question.item(n);
    const lines = [style.bold(style.plain(Messages.header(session)))];
    if (question.isBatch) lines.push(style.italic(`Вопрос ${n} из ${question.items.length}`));
    lines.push(`❓ ${style.bold(style.markdown(item.text))}`);
    if (item.options.length > 0) {
      lines.push(
        '',
        ...item.options.map(
          (o) => `${style.bold(style.plain(o.id))}: ${style.markdown(o.text)}${Messages.star(item, o.id)}`,
        ),
      );
    }
    const moved = question.terminalAt !== undefined;
    if (!moved) {
      const hint =
        item.options.length > 0 ? 'Ответь кнопкой или reply на это сообщение.' : 'Ответь reply на это сообщение.';
      lines.push('', style.italic(hint));
    }
    let text = lines.join('\n');
    if (question.status === 'open' && !item.resolution) {
      const wait = moved ? Messages.TERMINAL : Messages.waiting(question, timeZone);
      if (wait) text += `\n\n${wait}`;
    }
    const r = item.resolution;
    if (r?.by === 'agent') {
      const replay = Messages.humanAnswered(item) ? '' : ' Кнопки — чтобы переиграть.';
      text += `\n\n🤖 ${style.plain(`${Messages.choice(r)}${r.reason ? ` ${r.reason}` : ''}`)}.${replay}`;
    } else if (r?.by === 'human') {
      text += `\n\n👤 ${style.plain(Messages.choice(r))}${r.via === 'terminal' ? ' (в терминале)' : ''}.`;
    }
    for (const late of item.lateAnswers) text += `\n🔁 Переигрывание: ${style.plain(Messages.choice(late))}.`;
    if (view.sent === n) {
      const rest = question.items
        .map((it, i) => ({ it, k: i + 1 }))
        .filter(({ it, k }) => k > n && it.resolution?.via === 'terminal');
      if (rest.length > 0) {
        const answers = rest.map(({ it, k }) => style.plain(Messages.itemLine(it, k, it.resolution as Resolution)));
        text += `\n\n👤 В терминале:\n${answers.join('\n')}`;
      }
    }
    return text;
  }

  private static decidedRestIn(style: Style, question: Question, session: Session, sent: number): string {
    const rest = question.items
      .map((it, i) => ({ it, k: i + 1 }))
      .filter(({ it, k }) => k > sent && it.resolution?.by === 'agent');
    const reason = rest[0]?.it.resolution?.reason;
    return [
      style.bold(style.plain(Messages.header(session))),
      `🤖 ${style.plain(`Агент решил${reason ? ` ${reason}` : ''} остальные вопросы:`)}`,
      ...rest.map(({ it, k }) => style.plain(Messages.itemLine(it, k, it.resolution as Resolution))),
      '',
      style.italic('Переиграть — reply на это сообщение: уйдёт указанием.'),
    ].join('\n');
  }

  /** Вопрос переведён в терминал, пункт ещё не отвечен. */
  private static readonly TERMINAL = '🖥 Переведено в терминал — ответь там; reply здесь тоже примется.';

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
   * Кнопки сообщения пункта `n`. Ответил человек (в том числе переигрыванием) — кнопок нет, переиграть можно reply.
   * Переведён в терминал и пункт не отвечен — тоже нет (reply примется). Иначе — варианты (после решения агента —
   * для переигрывания); пока пункт открыт — «🖥 В терминал» и «Жди меня» (если вопрос с таймаутом и не удержан:
   * без таймаута агент и так ждёт). «Жди меня» и перевод действуют на всю пачку.
   */
  static questionButtons(question: Question, n = 1): Keyboard {
    const item = question.item(n);
    if (Messages.humanAnswered(item)) return [];
    const open = question.status === 'open' && !item.resolution;
    const moved = question.terminalAt !== undefined;
    if (open && moved) return [];
    const data = (o: string) => (question.isBatch ? `b:${question.id}:${n}:${o}` : `a:${question.id}:${o}`);
    const rows: Keyboard = item.options.map((o) => [{ text: `${o.id}${Messages.star(item, o.id)}`, data: data(o.id) }]);
    if (!open) return rows;
    if (question.heldAt === undefined && question.deadlineAt !== undefined) {
      rows.push([{ text: question.isBatch ? 'Жди меня (вся пачка)' : 'Жди меня', data: `h:${question.id}` }]);
    }
    rows.push([{ text: '🖥 В терминал', data: `t:${question.id}` }]);
    return rows;
  }

  private static humanAnswered(item: QuestionItem): boolean {
    return item.resolution?.by === 'human' || item.lateAnswers.length > 0;
  }

  /** Реакция на сообщение человека: входящее в ящике сессии. */
  static readonly INBOX_QUEUED = '✍';
  /** Реакция на сообщение человека: агент прочитал. */
  static readonly INBOX_READ = '👀';

  /** Меню `/sessions` (там только сессии на связи): по блоку на сессию — имя, машина с давностью статуса, статус. */
  static sessions(sessions: readonly Session[], now: number): string {
    return Messages.sessionsIn(PLAIN, sessions, now);
  }

  static sessionsHtml(sessions: readonly Session[], now: number): string {
    return Messages.sessionsIn(HTML, sessions, now);
  }

  private static sessionsIn(style: Style, sessions: readonly Session[], now: number): string {
    const block = (s: Session) => {
      const meta = s.status ? `${s.host} · ${Messages.ago(s.status.at, now)}` : `${s.host} · статуса нет`;
      const lines = [`🟢 ${style.bold(style.plain(s.label))}`, style.italic(style.plain(meta))];
      if (s.status) lines.push(style.markdown(s.status.text));
      return lines.join('\n');
    };
    return [
      style.bold('Сессии на связи:'),
      ...sessions.map(block),
      style.italic('Выбери адресата указания или команды (/clear, /compact, /exit).'),
    ].join('\n\n');
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

  /** Итог запуска окна по `/new` — reply на сообщение с задачей; `text` — окно или ошибка с хвостом экрана. */
  static launchOutcome(launch: Launch): string {
    const outcome = launch.outcome;
    if (!outcome) throw new Error(`у запуска ${launch.id} нет итога`);
    return outcome.ok
      ? `🪟 Окно открыто на ${launch.host}: ${outcome.text}`
      : `⚠️ Окно не открылось на ${launch.host}: ${outcome.text}`;
  }

  static readonly NO_HOSTS = 'Нет машин на связи: запусти herald host.';
  static readonly NEW_WINDOW_CANCELLED = '✖ Новое окно отменено.';
  static readonly NOTHING_TO_CANCEL = 'Отменять нечего.';
  static readonly STALE_BUTTON = '⚠️ кнопка устарела';

  /** Сообщение шага диалога `/new`. */
  static newWindowStep(dialog: NewWindowDialog): string {
    if (dialog.step === 'host') return '🪟 Новое окно. На какой машине?';
    if (dialog.step === 'dir') {
      return dialog.choices.length > 0
        ? `🪟 Новое окно на ${dialog.host}. Каталог? Выбери или пришли путь от ~.`
        : `🪟 Новое окно на ${dialog.host}. Пришли каталог — путь от ~.`;
    }
    const dir = Messages.dirLabel(dialog.dir ?? '');
    return `🪟 Новое окно: ${dialog.host} · ${dir}. Задача? Следующее сообщение уйдёт агенту первым.`;
  }

  /** Кнопки шага: варианты (`n:<метка>:h|d:<номер>`) и «Отмена» (`n:<метка>:x`). */
  static newWindowButtons(dialog: NewWindowDialog): Keyboard {
    const kind = dialog.step === 'host' ? 'h' : 'd';
    const label = dialog.step === 'host' ? (c: string) => c : Messages.dirLabel;
    return [
      ...dialog.choices.map((c, i) => [{ text: label(c), data: `n:${dialog.token}:${kind}:${i}` }]),
      [{ text: Messages.CANCEL_BUTTON, data: `n:${dialog.token}:x` }],
    ];
  }

  /** Каталог для человека: домашний — `~` (по виду пути: сервер не знает `$HOME` машины). */
  static dirLabel(dir: string): string {
    return dir.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
  }

  static launching(host: string): string {
    return `⏳ Открываю окно на ${host}…`;
  }

  static readonly NO_SESSIONS = 'Сессий на связи нет.';
  static readonly UNKNOWN_COMMAND =
    'Неизвестная команда. Есть: /new, /sessions, /status, /cancel, /clear, /compact, /exit.';
  /** Reply на сообщение, не связанное с сессией. */
  static readonly WHOM = 'Кому? Это сообщение не связано с сессией: напиши без reply или выбери адресата в /sessions.';
  /** Меню сообщения без адресата — reply на него с кнопками сессий; у команды терминала — с её именем. */
  static whomMenu(command?: string): string {
    return command ? `Кому ${command}?` : 'Кому?';
  }

  static readonly WHOM_CANCELLED = 'Отменено.';
  static readonly CANCEL_BUTTON = '✖ Отмена';
  /** Старая кнопка меню «Кому?»: сообщение уже ушло сессии. */
  static readonly ALREADY_SENT = 'Уже отправлено';

  /** Итог меню «Кому?» вместо его текста. */
  static addressed(session: Session): string {
    return `→ ${Messages.sessionButton(session)}`;
  }

  /** Кнопка вопроса, которого больше нет: удалён очисткой по сроку хранения. */
  static readonly QUESTION_GONE = '⚠️ вопрос устарел и удалён';

  static ago(at: number, now: number): string {
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ч назад`;
    return `${Math.floor(hours / 24)} дн назад`;
  }

  /** Текст ответа во входящих (первый пункт; у одиночного вопроса — сам вопрос): вариант с подписью или свободный текст. */
  static answerText(question: Question, r: Resolution): string {
    return Messages.answerOf(question.item(1), r);
  }

  /** Ответ на пункт пачки: «3. Логи? — B: файл». */
  static itemAnswerText(question: Question, n: number, r: Resolution): string {
    return Messages.itemLine(question.item(n), n, r);
  }

  /** Ответы на все пункты пачки — строка на пункт. */
  static answersText(question: Question): string {
    return question.items
      .flatMap((it, i) => (it.resolution ? [Messages.itemLine(it, i + 1, it.resolution)] : []))
      .join('\n');
  }

  /** Входящее `hold`: человек нажал «Жди меня». */
  static holdText(question: Question): string {
    return `Человек нажал «Жди меня» на вопросе ${question.id}: решать самому нельзя — жди его ответа без срока.`;
  }

  /** Входящее `to-terminal`: что уже отвечено и что спросить (варианты, рекомендованный). */
  static toTerminalText(question: Question): string {
    const done = question.items.map((it, i) => ({ it, k: i + 1 })).filter(({ it }) => it.resolution);
    const ask = question.items.map((it, i) => ({ it, k: i + 1 })).filter(({ it }) => !it.resolution);
    const lines = [
      `Человек перевёл вопрос ${question.id} в терминал: задай неотвеченные пункты здесь, своим UI, и закрой ответы инструментом answered (CLI — herald answered).`,
    ];
    if (done.length > 0) {
      lines.push('', 'Уже ответил:', ...done.map(({ it, k }) => Messages.itemLine(it, k, it.resolution as Resolution)));
    }
    lines.push(
      '',
      'Спросить:',
      ...ask.map(({ it, k }) => {
        const options = it.options.map((o) => `${o.id}: ${o.text}${Messages.star(it, o.id)}`).join('; ');
        return `${k}. ${it.text} — ${options ? `варианты: ${options}` : 'свободный ответ'}`;
      }),
    );
    return lines.join('\n');
  }

  private static itemLine(item: QuestionItem, n: number, r: Resolution): string {
    return `${n}. ${item.text} — ${Messages.answerOf(item, r)}`;
  }

  private static answerOf(item: QuestionItem, r: Resolution): string {
    if (r.option === undefined) return r.text ?? '';
    const option = item.options.find((o) => o.id === r.option);
    return option ? `${option.id}: ${option.text}` : r.option;
  }

  private static choice(r: Resolution): string {
    return r.option !== undefined ? `Принят ${r.option}` : `Принято «${r.text}»`;
  }

  private static star(item: QuestionItem, optionId: string): string {
    return item.recommended === optionId ? ' ⭐' : '';
  }
}
