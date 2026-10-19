import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resourcePath } from './resources.ts';

/** Kernel locking is native; acquisition order and reentrancy stay in persistence. */
export async function acquireFileLock(path: string) {
  const binary = resourcePath('core', 'spritebook-lock') +
    (process.platform === 'win32' ? '.exe' : '');
  const child = spawn(binary, [path], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (text) => stderr = (stderr + text).slice(-8192));
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await Promise.race([
      once(lines, 'line'),
      closed.then(() => {
        throw new Error(stderr || 'Workspace lock helper exited before acquisition.');
      }),
    ]);
    if (line !== 'locked') throw new Error('Invalid workspace lock helper response.');
  } catch (error) {
    child.kill();
    await closed.catch(() => {});
    throw error;
  } finally {
    lines.close();
  }
  return {
    async close() {
      child.stdin.end();
      const [code] = await closed;
      if (code !== 0) throw new Error(stderr || `Workspace lock helper exited with code ${code}.`);
    },
  };
}
