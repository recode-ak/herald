#!/usr/bin/env bun
/** CLI herald. Ставится в `~/.local/bin/herald` командой `bun run link`. */
import { DetachedProcess, SystemClock } from '../infra/system.ts';
import { Cli } from './cli.ts';

const cli = new Cli({
  env: process.env,
  cwd: process.cwd(),
  clock: new SystemClock(),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  stdin: () => Bun.stdin.text(),
  // Тот же bun и тот же main.ts: фоновый процесс — та же версия herald.
  detach: (argv, log) => DetachedProcess.spawn([process.execPath, Bun.main, ...argv], log),
});
process.exit(await cli.run(process.argv.slice(2)));
