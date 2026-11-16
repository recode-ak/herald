/** Неверные аргументы командной строки. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** Какие флаги принимает команда: со значением, повторяемые, без значения. Имена — без дефисов. */
export interface ArgsSpec {
  values?: readonly string[];
  lists?: readonly string[];
  switches?: readonly string[];
}

/** Разобранные аргументы: `--x v`, `--x=v`, `-o v` (повторяемый), переключатели; после `--` — всё позиционное. */
export class Args {
  private constructor(
    readonly positional: string[],
    private readonly values: Map<string, string>,
    private readonly lists: Map<string, string[]>,
    private readonly switches: Set<string>,
  ) {}

  static parse(argv: readonly string[], spec: ArgsSpec): Args {
    const positional: string[] = [];
    const values = new Map<string, string>();
    const lists = new Map<string, string[]>();
    const switches = new Set<string>();
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i] as string;
      if (arg === '--') {
        positional.push(...argv.slice(i + 1));
        break;
      }
      if (!arg.startsWith('-') || arg === '-') {
        positional.push(arg);
        continue;
      }
      const eq = arg.indexOf('=');
      const name = arg.slice(0, eq < 0 ? undefined : eq).replace(/^--?/, '');
      const inline = eq < 0 ? undefined : arg.slice(eq + 1);
      if (spec.switches?.includes(name)) {
        if (inline !== undefined) throw new UsageError(`${arg}: у --${name} нет значения`);
        switches.add(name);
        continue;
      }
      const isList = spec.lists?.includes(name) ?? false;
      if (!isList && !spec.values?.includes(name)) throw new UsageError(`неизвестный флаг ${arg}`);
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`${arg}: нужно значение`);
      if (isList) lists.set(name, [...(lists.get(name) ?? []), value]);
      else values.set(name, value);
    }
    return new Args(positional, values, lists, switches);
  }

  value(name: string): string | undefined {
    return this.values.get(name);
  }

  list(name: string): string[] {
    return this.lists.get(name) ?? [];
  }

  has(name: string): boolean {
    return this.switches.has(name);
  }

  /** Значение в секундах (целое ≥ 0) → мс; нет флага — `undefined`. */
  seconds(name: string): number | undefined {
    const raw = this.value(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value)) {
      throw new UsageError(`--${name}: «${raw}» — ожидается целое число секунд ≥ 0`);
    }
    return value * 1000;
  }
}
