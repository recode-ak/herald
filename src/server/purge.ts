#!/usr/bin/env bun
/** Очистка базы по сроку хранения: `bun run purge [--days N] [--dry-run]` (правила — `docs/model.md`, «Хранение»). */
import { ConfigError } from './config.ts';
import { PurgeCommand } from './purge-command.ts';

try {
  const output = PurgeCommand.parse(process.argv.slice(2), process.env).run(Date.now());
  console.log(JSON.stringify(output));
} catch (error) {
  console.error(`herald purge: ${error instanceof ConfigError ? error.message : error}`);
  process.exit(1);
}
