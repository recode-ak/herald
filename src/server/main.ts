#!/usr/bin/env bun
/** Запуск сервера: `bun src/server/main.ts` из каталога с `.env` (переменные — `docs/model.md`, «Сервер»). */
import { ConfigError, ServerConfig } from './config.ts';
import { HeraldServer } from './herald-server.ts';

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

let config: ServerConfig;
try {
  config = ServerConfig.fromEnv(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`herald: ошибка конфига: ${error.message}`);
  process.exit(1);
}

const server = HeraldServer.start(config, { log });
log(`herald слушает ${server.url} (БД: ${config.dbPath})`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    log(`herald: ${signal}, остановка`);
    await server.stop();
    process.exit(0);
  });
}
