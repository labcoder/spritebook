import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntimeReceiptSchema, ModelRuntimeRecipeSchema, parseWith } from '@spritebook/schema';
import { resourcePath } from './resources.ts';

export function runtimeDataDir(): string {
  const data = process.platform === 'win32'
    ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local')
    : process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support')
    : process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share');
  return join(data, 'spritebook/runtime');
}

export async function sidecarEnvironmentDir(sidecarDir: string): Promise<string> {
  const lock = createHash('sha256').update(await readFile(join(sidecarDir, 'uv.lock'))).digest(
    'hex',
  );
  return join(runtimeDataDir(), `sidecar-${lock.slice(0, 16)}`);
}

export async function modelRuntime(id: string, sidecarDir = resourcePath('sidecar')) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Invalid model runtime ID');
  const recipePath = join(sidecarDir, 'runtimes', `${id}.json`);
  const bytes = await readFile(recipePath);
  const recipe = parseWith(
    ModelRuntimeRecipeSchema,
    JSON.parse(bytes.toString('utf8')),
    recipePath,
  );
  if (recipe.id !== id) throw new Error(`Runtime recipe identity mismatch: ${id}`);
  const project = join(sidecarDir, recipe.project);
  const hash = createHash('sha256').update(bytes).update(await readFile(join(project, 'uv.lock')));
  if (recipe.prepare) hash.update(await readFile(join(sidecarDir, recipe.prepare.script)));
  hash.update(await readFile(join(sidecarDir, recipe.check)));
  hash.update(await readFile(join(sidecarDir, 'runtimes/unpack.py')));
  const fingerprint = hash.digest('hex');
  const root = join(runtimeDataDir(), `${id}-${fingerprint.slice(0, 16)}`);
  const environment = recipe.project === '.'
    ? await sidecarEnvironmentDir(sidecarDir)
    : join(root, '.venv');
  return { recipe, recipePath, fingerprint, root, project, environment, sidecarDir };
}

/** A partial or corrupt preparation is never exposed to a model adapter. */
export async function readModelRuntime(info: Awaited<ReturnType<typeof modelRuntime>>) {
  let data: string;
  try {
    data = await readFile(join(info.root, 'ready.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const receipt = parseWith(ModelRuntimeReceiptSchema, JSON.parse(data), 'model runtime receipt');
  if (receipt.fingerprint !== info.fingerprint) {
    throw new Error('Model runtime fingerprint mismatch');
  }
  if (!await stat(join(info.environment, 'pyvenv.cfg')).catch(() => null)) {
    throw new Error('Model environment is missing. Run spritebook models setup again.');
  }
  for (const [path, expected] of Object.entries(receipt.files)) {
    const actual = createHash('sha256').update(await readFile(join(info.root, path))).digest('hex');
    if (actual !== expected) {
      throw new Error(`Prepared model source changed: ${path}. Run spritebook models setup again.`);
    }
  }
  return receipt;
}
