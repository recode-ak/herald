/** Расширение herald для pi: точка входа (подключение — `docs/install.md`). Только API Node: pi работает в Node. */
import { HeraldClient } from '../client/client.ts';
import { ClientConfig } from '../client/config.ts';
import { SessionLocator } from '../client/locator.ts';
import { SystemClock } from '../infra/system.ts';
import { HeraldExtension, type PiApi } from './extension.ts';

export default function heraldPi(pi: PiApi): void {
  new HeraldExtension(pi, {
    connect: ({ cwd, sessionId }) => {
      const config = ClientConfig.load(process.env);
      const session = new SessionLocator(config.host).locate({
        cwd,
        name: process.env.HERALD_SESSION,
        agentSession: sessionId,
      });
      return new HeraldClient({ serverUrl: config.serverUrl, token: config.token, session, clock: new SystemClock() });
    },
  }).register();
}
