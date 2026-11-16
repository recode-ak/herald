import type { QuestionOption } from '../domain/question.ts';
import type { SessionRef } from '../domain/session.ts';

/** Неверный запрос: не JSON, нет поля, неверный тип. → 400. */
export class BadRequestError extends Error {
  override name = 'BadRequestError';
}

/** Тело JSON-запроса с типизированным чтением полей. Смысл значений проверяет домен. */
export class RequestBody {
  private constructor(private readonly data: Record<string, unknown>) {}

  static async read(req: Request): Promise<RequestBody> {
    let data: unknown;
    try {
      data = await req.json();
    } catch {
      throw new BadRequestError('тело запроса — не JSON');
    }
    if (!RequestBody.isObject(data)) throw new BadRequestError('тело запроса — не JSON-объект');
    return new RequestBody(data);
  }

  string(name: string): string {
    const value = this.data[name];
    if (typeof value !== 'string') throw new BadRequestError(`поле «${name}» — ожидается строка`);
    return value;
  }

  optionalString(name: string): string | undefined {
    return this.data[name] === undefined ? undefined : this.string(name);
  }

  /** Неотрицательное целое (мс ожидания); нет поля — 0. */
  waitMs(name = 'waitMs'): number {
    const value = this.data[name];
    if (value === undefined) return 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new BadRequestError(`поле «${name}» — ожидается целое ≥ 0`);
    }
    return value;
  }

  strings(name: string): string[] {
    const value = this.data[name];
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw new BadRequestError(`поле «${name}» — ожидается массив строк`);
    }
    return value;
  }

  /** Массив строк; нет поля — пусто. */
  optionalStrings(name: string): string[] {
    return this.data[name] === undefined ? [] : this.strings(name);
  }

  options(name = 'options'): QuestionOption[] {
    const value = this.data[name];
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      !value.every((o) => RequestBody.isObject(o) && typeof o.id === 'string' && typeof o.text === 'string')
    ) {
      throw new BadRequestError(`поле «${name}» — ожидается массив { id, text }`);
    }
    return value.map((o) => ({ id: o.id, text: o.text }));
  }

  session(name = 'session'): SessionRef {
    const value = this.data[name];
    if (!RequestBody.isObject(value)) {
      throw new BadRequestError(`поле «${name}» — ожидается { host, root, name?, instance? }`);
    }
    const inner = new RequestBody(value);
    const ref: SessionRef = { host: inner.string('host'), root: inner.string('root') };
    const sessionName = inner.optionalString('name');
    const instance = inner.optionalString('instance');
    return {
      ...ref,
      ...(sessionName !== undefined && { name: sessionName }),
      ...(instance !== undefined && { instance }),
    };
  }

  private static isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
