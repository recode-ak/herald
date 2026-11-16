import { describe, expect, test } from 'bun:test';
import { Markup } from './markup.ts';

describe('Markup.escape', () => {
  test('экранирует &, <, >, "', () => {
    expect(Markup.escape('a < b && c > "d"')).toBe('a &lt; b &amp;&amp; c &gt; &quot;d&quot;');
  });
});

describe('Markup.markdown → HTML Telegram', () => {
  test.each([
    ['обычный текст', 'обычный текст'],
    ['**жирный** и __ничего__', '<b>жирный</b> и __ничего__'],
    ['_курсив_ и *тоже*', '<i>курсив</i> и <i>тоже</i>'],
    ['~~зачёркнуто~~', '<s>зачёркнуто</s>'],
    ['`код <x>`', '<code>код &lt;x&gt;</code>'],
    ['```ts\nconst a = 1 < 2;\n```', '<pre>const a = 1 &lt; 2;</pre>'],
    ['[доки](https://x.kz/a_b_c?q=1&r=2)', '<a href="https://x.kz/a_b_c?q=1&amp;r=2">доки</a>'],
    ['[**жирная** ссылка](https://x.kz)', '<a href="https://x.kz"><b>жирная</b> ссылка</a>'],
    ['# Заголовок\nтекст', '<b>Заголовок</b>\nтекст'],
    ['- раз\n* два\n  - вложенный', '• раз\n• два\n  • вложенный'],
    ['1 < 2 & 3 > 2', '1 &lt; 2 &amp; 3 &gt; 2'],
  ])('%p', (source, html) => {
    expect(Markup.markdown(source)).toBe(html);
  });

  test('не разметка: snake_case, одиночные символы, незакрытые пары, пробелы у маркеров', () => {
    for (const source of [
      'имя_файла_тут и snake_case_name',
      '2 * 3 * 4',
      '**незакрыто',
      '`незакрыто',
      '```незакрытый блок',
      '_ не курсив _',
      '[ссылка](javascript:alert(1))',
    ]) {
      expect(Markup.markdown(source)).toBe(Markup.escape(source));
    }
  });

  test('внутри кода разметка не работает', () => {
    expect(Markup.markdown('`**x** _y_`')).toBe('<code>**x** _y_</code>');
    expect(Markup.markdown('```\n**x**\n- y\n```')).toBe('<pre>**x**\n- y</pre>');
  });
});
