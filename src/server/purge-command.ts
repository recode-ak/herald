import { existsSync } from 'node:fs';
import type { PurgeReport } from '../app/store.ts';
import { DomainError } from '../domain/errors.ts';
import { Retention } from '../domain/retention.ts';
import { SqliteStore } from '../infra/sqlite-store.ts';
import { ConfigError } from './config.ts';

type Env = Record<string, string | undefined>;

/** Итог команды: граница (ISO), срок, режим и отчёт хранилища. */
export interface PurgeOutput extends PurgeReport {
  cutoff: string;
  days: number;
  dryRun: boolean;
}

/**
 * Очистка базы по сроку хранения: `bun run purge [--days N] [--dry-run]` из каталога с `.env`.
 * Срок — `--days`, иначе `HERALD_RETENTION_DAYS`, иначе `Retention.DEFAULT`; база — `HERALD_DB`, как у сервера.
 */
export class PurgeCommand {
  static readonly USAGE = 'bun run purge [--days N] [--dry-run]';

  private constructor(
    readonly retention: Retention,
    readonly dbPath: string,
    readonly dryRun: boolean,
  ) {}

  static parse(argv: readonly string[], env: Env): PurgeCommand {
    let days = env.HERALD_RETENTION_DAYS?.trim() || undefined;
    let source = 'HERALD_RETENTION_DAYS';
    let dryRun = false;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--dry-run') dryRun = true;
      else if (arg === '--days') {
        days = argv[++i];
        source = '--days';
        if (days === undefined) throw new ConfigError(`--days: нет значения (${PurgeCommand.USAGE})`);
      } else throw new ConfigError(`неизвестный аргумент ${arg} (${PurgeCommand.USAGE})`);
    }
    return new PurgeCommand(
      days === undefined ? Retention.DEFAULT : PurgeCommand.retention(source, days),
      env.HERALD_DB?.trim() || './data/herald.db',
      dryRun,
    );
  }

  /** Выполнить очистку на момент `now`. Нет файла базы — ошибка: команда базу не создаёт. */
  run(now: number): PurgeOutput {
    if (!existsSync(this.dbPath)) throw new ConfigError(`нет базы ${this.dbPath} (HERALD_DB, каталог запуска)`);
    const store = SqliteStore.open(this.dbPath);
    try {
      const cutoff = this.retention.cutoff(now);
      const report = store.purge(cutoff, { dryRun: this.dryRun });
      return { cutoff: new Date(cutoff).toISOString(), days: this.retention.days, dryRun: this.dryRun, ...report };
    } finally {
      store.close();
    }
  }

  private static retention(source: string, raw: string): Retention {
    try {
      return Retention.ofDays(Number(raw));
    } catch (error) {
      if (error instanceof DomainError) throw new ConfigError(`${source}: «${raw}» — ожидается целое число дней ≥ 1`);
      throw error;
    }
  }
}
