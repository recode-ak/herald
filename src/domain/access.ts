/** Идентификатор человека — имя из конфига (`nur`). */
export type PersonId = string;

export class AccessConfigError extends Error {
  override name = 'AccessConfigError';
}

/**
 * Кто может пользоваться herald: токены агентов → человек, человек → chat_id в Telegram.
 * Строится из `HERALD_TOKENS=человек:токен,…` и `HERALD_PEOPLE=человек:chat_id,…`.
 */
export class Access {
  private constructor(
    private readonly tokens: ReadonlyMap<string, PersonId>,
    private readonly chats: ReadonlyMap<PersonId, number>,
    private readonly peopleByChat: ReadonlyMap<number, PersonId>,
  ) {}

  static parse(tokensLine: string, peopleLine: string): Access {
    const tokens = new Map<string, PersonId>();
    for (const [person, token] of Access.pairs(tokensLine, 'HERALD_TOKENS')) {
      if (tokens.has(token)) throw new AccessConfigError(`HERALD_TOKENS: токен повторяется (человек «${person}»)`);
      tokens.set(token, person);
    }

    const chats = new Map<PersonId, number>();
    const peopleByChat = new Map<number, PersonId>();
    for (const [person, raw] of Access.pairs(peopleLine, 'HERALD_PEOPLE')) {
      const chatId = Number(raw);
      if (!Number.isSafeInteger(chatId))
        throw new AccessConfigError(`HERALD_PEOPLE: chat_id «${raw}» — не целое число`);
      if (chats.has(person)) throw new AccessConfigError(`HERALD_PEOPLE: человек «${person}» указан дважды`);
      if (peopleByChat.has(chatId)) throw new AccessConfigError(`HERALD_PEOPLE: chat_id ${chatId} указан дважды`);
      chats.set(person, chatId);
      peopleByChat.set(chatId, person);
    }

    for (const person of tokens.values()) {
      if (!chats.has(person)) throw new AccessConfigError(`у человека «${person}» есть токен, но нет chat_id`);
    }
    return new Access(tokens, chats, peopleByChat);
  }

  personByToken(token: string): PersonId | undefined {
    return this.tokens.get(token);
  }

  personByChatId(chatId: number): PersonId | undefined {
    return this.peopleByChat.get(chatId);
  }

  chatIdOf(person: PersonId): number {
    const chatId = this.chats.get(person);
    if (chatId === undefined) throw new AccessConfigError(`нет chat_id для человека «${person}»`);
    return chatId;
  }

  /** Разбор строки `ключ:значение,ключ:значение`. */
  private static pairs(line: string, name: string): [string, string][] {
    const items = line
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length === 0) throw new AccessConfigError(`${name}: пусто`);
    return items.map((item) => {
      const at = item.indexOf(':');
      const key = item.slice(0, at).trim();
      const value = item.slice(at + 1).trim();
      if (at < 0 || !key || !value)
        throw new AccessConfigError(`${name}: запись «${item}» — ожидается «человек:значение»`);
      return [key, value];
    });
  }
}
