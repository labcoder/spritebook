import { spawn, type SpawnOptions } from 'node:child_process';
import { once } from 'node:events';

/** Keep nonzero exits observable for real crash and cancellation fixtures. */
export async function runProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
) {
  const child = spawn(command, args, {
    ...options,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code, signal] = await once(child, 'close');
  return {
    code: code ?? 1,
    signal,
    success: code === 0,
    stdout: new Uint8Array(Buffer.concat(stdout)),
    stderr: new Uint8Array(Buffer.concat(stderr)),
  };
}
