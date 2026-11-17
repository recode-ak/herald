import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Clock, Ids } from '../app/ports.ts';

/** Системные часы. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

/** Случайные id `префикс_` + 10 символов [0-9a-z] (~51 бит): коротко для callback_data. */
export class RandomIds implements Ids {
  private static readonly ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
  private static readonly LENGTH = 10;

  next(prefix: string): string {
    let id = '';
    while (id.length < RandomIds.LENGTH) {
      for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
        // 252 = 7 × 36: отбрасываем хвост, чтобы символы были равновероятны.
        if (byte < 252 && id.length < RandomIds.LENGTH) id += RandomIds.ALPHABET[byte % 36];
      }
    }
    return `${prefix}_${id}`;
  }
}

/**
 * Процесс фоном отдельной сессией (`setsid -f`): переживает родителя, его группу процессов и терминал
 * (Bash агента после команды завершает своё). Вывод дописывается в `log`.
 */
export class DetachedProcess {
  async spawn(command: readonly string[], log: string): Promise<void> {
    mkdirSync(dirname(log), { recursive: true });
    const fd = openSync(log, 'a');
    try {
      // setsid -f выходит сразу после fork: ждём только его.
      const code = await Bun.spawn(['setsid', '-f', ...command], { stdin: 'ignore', stdout: fd, stderr: fd }).exited;
      if (code !== 0) throw new Error(`setsid: код ${code}`);
    } finally {
      closeSync(fd);
    }
  }
}
