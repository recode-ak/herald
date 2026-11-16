#!/usr/bin/env bun
/** Канал herald для Claude Code (MCP по stdio). Подключение — `docs/install.md`. Логи — только в stderr. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HeraldClient } from '../client/client.ts';
import { ClientConfig } from '../client/config.ts';
import { SessionLocator } from '../client/locator.ts';
import { Session } from '../domain/session.ts';
import { SystemClock } from '../infra/system.ts';
import { HeraldChannel } from './channel.ts';

const log = (message: string) => process.stderr.write(`${message}\n`);

let config: ClientConfig;
try {
  config = ClientConfig.load(process.env);
} catch (error) {
  log(`herald channel: ${(error as Error).message}`);
  process.exit(1);
}

const session = new SessionLocator(config.host).locate({
  cwd: process.cwd(),
  name: process.env.HERALD_SESSION,
  agentSession: process.env.CLAUDE_CODE_SESSION_ID,
});
const herald = new HeraldClient({
  serverUrl: config.serverUrl,
  token: config.token,
  session,
  clock: new SystemClock(),
});
const channel = new HeraldChannel({ herald, log, permissionRelay: process.env.HERALD_PERMISSION_RELAY === '1' });
// Claude Code закрыл канал или процесс останавливают — herald узнаёт, что окно закрыто (сессия ⚪).
const exit = () => void channel.close().finally(() => process.exit(0));
channel.onclose = exit;
process.on('SIGTERM', exit);
process.on('SIGINT', exit);
await channel.connect(new StdioServerTransport());
channel.start();
log(`herald channel: сессия ${Session.keyOf(session)} → ${config.serverUrl}`);
