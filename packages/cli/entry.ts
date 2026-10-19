#!/usr/bin/env node
import { runCli } from './mod.ts';
import { disposeGpu } from '@spritebook/render';

const args = process.argv.slice(2);
// The desktop assigns the process to its owned tree before releasing this gate.
if (args[0] === '--owned-start') {
  args.shift();
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 64) break;
  }
  if (input !== 'start\n') process.exit(130);
}

try {
  process.exitCode = await runCli(args, {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
} finally {
  await disposeGpu();
}
