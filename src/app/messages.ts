import type { Question, Resolution } from '../domain/question.ts';
import type { Session } from '../domain/session.ts';
import type { Keyboard } from './telegram.ts';

/** Тексты и кнопки сообщений бота. Без parse_mode — экранирование не нужно. */
export class Messages {
  static readonly CALLBACK_MAX_BYTES = 64;

  static header(session: Session): string {
    return `[${session.host} · ${session.project}]`;
  }

  static notify(session: Session, text: string): string {
    return `${Messages.header(session)}\n${text}`;
  }

  /** Текст вопроса с текущим состоянием: решение и переигрывания. */
  static question(question: Question, session: Session): string {
    const lines = [Messages.header(session), `❓ ${question.text}`];
    if (question.options.length > 0) {
      lines.push('', ...question.options.map((o) => `${o.id}: ${o.text}${Messages.star(question, o.id)}`));
    }
    lines.push(
      '',
      question.options.length > 0 ? 'Ответь кнопкой или reply на это сообщение.' : 'Ответь reply на это сообщение.',
    );
    let text = lines.join('\n');
    if (question.heldAt !== undefined && question.status === 'open') text += '\n\n⏸ Агент ждёт твоего ответа.';
    const r = question.resolution;
    if (r?.by === 'agent') {
      text += `\n\n🤖 ${Messages.choice(r)}${r.reason ? ` ${r.reason}` : ''}. Кнопки — чтобы переиграть.`;
    } else if (r?.by === 'human') {
      text += `\n\n👤 ${Messages.choice(r)}.`;
    }
    for (const late of question.lateAnswers) text += `\n🔁 Переигрывание: ${Messages.choice(late)}.`;
    return text;
  }

  /** Кнопки вариантов и «Жди меня». */
  static questionButtons(question: Question): Keyboard {
    return [
      ...question.options.map((o) => [
        { text: `${o.id}${Messages.star(question, o.id)}`, data: `a:${question.id}:${o.id}` },
      ]),
      [{ text: 'Жди меня', data: `h:${question.id}` }],
    ];
  }

  static inboxQueued(session: Session): string {
    return `📥 в ящике сессии ${session.project}`;
  }

  static inboxRead(session: Session): string {
    return `✅ прочитано агентом · сессия ${session.project}`;
  }

  private static choice(r: Resolution): string {
    return r.option !== undefined ? `Принят ${r.option}` : `Принято «${r.text}»`;
  }

  private static star(question: Question, optionId: string): string {
    return question.recommended === optionId ? ' ⭐' : '';
  }
}
