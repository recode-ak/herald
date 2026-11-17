/** Терминал окна агента: текст набирается в поле ввода так, будто его ввёл человек (реализация — `TmuxTerminal`). */
export interface Terminal {
  /** Набрать текст и отправить (Enter). */
  send(text: string): Promise<void>;
}
