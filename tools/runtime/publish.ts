import { strict as assert } from 'node:assert';
import { rename, rm, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

async function exists(path: string) {
  return stat(path).then(() => true).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
}

/** Recover a builder killed between the two directory renames on Windows. */
export async function recoverRuntime(out: string) {
  assert.equal(basename(out), 'runtime');
  const backup = `${out}-backup`;
  if (!await exists(backup)) return;
  if (!await exists(out)) await rename(backup, out);
  else await rm(backup, { recursive: true });
}

export async function publishRuntime(stage: string, out: string) {
  assert.equal(dirname(stage), dirname(out));
  assert(basename(stage).startsWith('runtime-stage-'));
  await recoverRuntime(out);
  const backup = `${out}-backup`;
  const previous = await exists(out);
  if (previous) await rename(out, backup);
  try {
    await rename(stage, out);
  } catch (error) {
    if (previous) await rename(backup, out);
    throw error;
  }
  if (previous) await rm(backup, { recursive: true });
}
