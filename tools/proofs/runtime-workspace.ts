/** Opt-in preserved-copy conversion and rollback; Deno runs only inside the pinned legacy checkout. */
import { strict as assert } from 'node:assert';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { runProcess } from '../testing/process.ts';
import { CHARACTER_SCHEMA_VERSION } from '@spritebook/schema';
import { decode } from '@spritebook/image';

const [controlArg, legacyArg, outArg] = process.argv.slice(2);
assert(
  controlArg && legacyArg && outArg,
  'usage: node tools/proofs/runtime-workspace.ts <F0-control> <F1-legacy-checkout> <new-output>',
);
const control = resolve(controlArg), legacy = resolve(legacyArg), out = resolve(outArg);
await mkdir(out);
const cliEntry = resolve('packages/cli/dist/entry.js');
const workspace = join(out, 'converted é 空'), rollback = join(out, 'original copy');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function hashes(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(join(root, entry.name), path));
    else result[path] = sha(await readFile(join(root, entry.name)));
  }
  return result;
}
const seal = await hashes(join(control, 'workspace'));
await cp(join(control, 'workspace'), workspace, { recursive: true });
await cp(join(control, 'workspace'), rollback, { recursive: true });
assert.deepEqual(await hashes(workspace), seal);
assert.deepEqual(await hashes(rollback), seal);
const before = JSON.parse(await readFile(join(workspace, 'character.json'), 'utf8'));
const transcript: unknown[] = [];
async function cli(args: string[], expectedCode = 0) {
  const result = await runProcess(process.execPath, [cliEntry, ...args, '--json']);
  const stdout = new TextDecoder().decode(result.stdout),
    stderr = new TextDecoder().decode(result.stderr);
  transcript.push({ args, code: result.code, stdout, stderr });
  assert.equal(result.code, expectedCode, `${args[0]}: ${stdout}\n${stderr}`);
  return stdout;
}
await cli(['workspace', '--workspace', workspace]);
assert.deepEqual(JSON.parse(await readFile(join(workspace, 'character.json'), 'utf8')), before);
await cli(['rename', '--workspace', workspace, '--name', 'Node conversion']);
await cli(['undo', '--manifest', join(workspace, 'character.json')]);
assert.deepEqual(JSON.parse(await readFile(join(workspace, 'character.json'), 'utf8')), before);
await cli(['redo', '--manifest', join(workspace, 'character.json')]);
await cli(['undo', '--manifest', join(workspace, 'character.json')]);
const after = await hashes(workspace);
for (const [path, hash] of Object.entries(seal)) {
  if (
    path.startsWith('canonical') || path.startsWith('source') || path.startsWith('results') ||
    path.startsWith('rig') || path.startsWith('bakes')
  ) assert.equal(after[path], hash, `Preserved bytes: ${path}`);
}
const journal = 'character.json.journal.ndjson';
const patches = (bytes: string) =>
  bytes.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const originalPatches = patches(await readFile(join(control, 'workspace', journal), 'utf8'));
assert.deepEqual(
  patches(await readFile(join(workspace, journal), 'utf8')).slice(0, originalPatches.length),
  originalPatches,
  'Original history prefix is preserved',
);
const oldBake = join(workspace, 'bakes', `bake-${before.lastBakeId}`);
const exports = join(out, 'exports');
await cli([
  'export',
  '--bake',
  oldBake,
  '--out',
  exports,
  '--targets',
  'godot,aseprite,texturepacker,strips',
]);
for (const [path, hash] of Object.entries(await hashes(join(control, 'exports')))) {
  const bytes = await readFile(join(exports, path));
  if (path.endsWith('.png')) {
    const a = decode(bytes, { checkCrc: true }),
      b = decode(await readFile(join(control, 'exports', path)), { checkCrc: true });
    assert.deepEqual([a.width, a.height, a.depth, a.channels], [
      b.width,
      b.height,
      b.depth,
      b.channels,
    ]);
    assert.deepEqual(a.data, b.data, `Preserved exported pixels: ${path}`);
  } else assert.equal(sha(bytes), hash, `Preserved exporter metadata: ${path}`);
}
const future = join(out, 'future schema');
await mkdir(future);
await writeFile(
  join(future, 'character.json'),
  JSON.stringify({ ...before, schemaVersion: CHARACTER_SCHEMA_VERSION + 1 }),
);
assert.match(await cli(['workspace', '--workspace', future], 1), /future|unsupported|newer/i);
for (const dir of [rollback, workspace]) {
  const result = await runProcess('deno', [
    'run',
    '--frozen',
    '-A',
    join(legacy, 'packages/cli/mod.ts'),
    'workspace',
    '--workspace',
    dir,
    '--json',
  ], { cwd: legacy });
  const stdout = new TextDecoder().decode(result.stdout),
    stderr = new TextDecoder().decode(result.stderr);
  transcript.push({ legacy: dir, code: result.code, stdout, stderr });
  assert.equal(result.code, 0, stderr);
  assert(stdout.includes(before.id), 'Legacy release can reopen the preserved character');
}
assert.deepEqual(
  await hashes(join(control, 'workspace')),
  seal,
  'The original control was never modified',
);
await writeFile(
  join(out, 'report.json'),
  JSON.stringify(
    {
      schemaVersion: CHARACTER_SCHEMA_VERSION,
      id: before.id,
      originalSeal: seal,
      checks: [
        'unchanged initial copy',
        'query/rename/undo/redo',
        'preserved accepted/source/history assets',
        'all old export metadata and decoded pixels',
        'future schema refusal',
        'old release reopens original and converted copies',
        'immutable original control',
      ],
      transcript,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Preserved workspace and rollback checks passed: ${out}`);
