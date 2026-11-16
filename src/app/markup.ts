/**
 * Упрощённый Markdown агента → HTML Telegram (`parse_mode: HTML`). Поддержано: **жирный**, _курсив_ / *курсив*,
 * ~~зачёркнутый~~, `код`, блоки ```, [ссылка](http…), заголовки `#` (жирным), списки «- » / «* » (точкой).
 * Всё прочее — текст как есть, экранированный: HTML всегда корректен, незакрытые маркеры остаются символами.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: правило проекта — класс с зоной ответственности вместо россыпи функций
export class Markup {
  private static readonly MARK = '\uE000';

  static escape(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  }

  static markdown(source: string): string {
    // Готовые фрагменты HTML (код, ссылки) прячутся за метками из символа частного использования,
    // чтобы разметка не трогала их содержимое; сам символ из исходника убирается.
    const parts: string[] = [];
    const keep = (html: string) => `${Markup.MARK}${parts.push(html) - 1}${Markup.MARK}`;

    let text = source
      .replaceAll(Markup.MARK, '')
      .replace(/```[^\n`]*\n([\s\S]*?)\n?```/g, (_, code: string) => keep(`<pre>${Markup.escape(code)}</pre>`))
      .replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${Markup.escape(code)}</code>`));
    text = Markup.escape(text).replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) =>
      keep(`<a href="${url}">${Markup.inline(label)}</a>`),
    );
    text = text
      .split('\n')
      .map((line) => Markup.inline(Markup.block(line)))
      .join('\n');
    return text.replace(/\uE000(\d+)\uE000/g, (_, i: string) => parts[Number(i)] ?? '');
  }

  /** Строчные конструкции: заголовок и пункт списка. */
  private static block(line: string): string {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) return `<b>${heading[1]}</b>`;
    return line.replace(/^(\s*)[-*]\s+/, '$1• ');
  }

  /** Выделения внутри строки; маркер не прилегает к пробелу, `_` и `*` — не внутри слова. */
  private static inline(text: string): string {
    return text
      .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<b>$1</b>')
      .replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '<s>$1</s>')
      .replace(/(?<![\p{L}\p{N}_*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\p{L}\p{N}_*])/gu, '<i>$1</i>')
      .replace(/(?<![\p{L}\p{N}_])_(?![\s_])([^_\n]+?)(?<!\s)_(?![\p{L}\p{N}_])/gu, '<i>$1</i>');
  }
}
