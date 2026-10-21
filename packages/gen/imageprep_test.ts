import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '@std/assert';
import { decode, encode } from 'fast-png';
import {
  moveManifestCursor,
  readWorkspace,
  SidecarSession,
  sourceImagePath,
  workspacePaths,
} from '@spritebook/core';
import type { JobEvent, SidecarJobRequest } from '@spritebook/schema';
import { loadCatalog, runInstallJob } from '@spritebook/registry';
import { runGenJob, sha256Hex } from './dist/gen.js';

test('gen prepares an opaque source once before generating its candidates', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'sb-gen-prep-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const catalog = await loadCatalog();
  const fixture = catalog.models.find((m) => m.id === 'fixture-gen')!;
  const version = fixture.versions[0]!;
  (version.paramsSchema as { properties: Record<string, unknown> }).properties.steps = {
    type: 'integer',
    minimum: 1,
    maximum: 50,
  };
  (version.paramsSchema as { properties: Record<string, unknown> }).properties.decimationTarget = {
    type: 'integer',
    minimum: 10000,
    maximum: 2000000,
  };
  const prep = catalog.models.find((m) => m.id === 'rembg-u2net')!;
  // Weightless prep stand-in: the job, install receipts and gates stay real.
  prep.versions[0]!.files = [];
  const catalogPath = join(root, 'catalog.json');
  await fs.writeFile(catalogPath, JSON.stringify(catalog));
  const modelsRoot = join(root, 'models');
  for (const modelId of ['fixture-gen', 'rembg-u2net']) {
    const installed = await Array.fromAsync(runInstallJob({
      jobId: 'install',
      modelId,
      root: modelsRoot,
      catalog,
    }));
    assertEquals(installed.at(-1)?.t, 'done', JSON.stringify(installed.at(-1)));
  }
  const pixels = new Uint8Array(8 * 8 * 4).fill(255);
  const image = join(root, 'opaque.png');
  const original = encode({ width: 8, height: 8, data: pixels });
  await fs.writeFile(image, original);
  const requests: SidecarJobRequest[] = [];
  let removeBackground = true;
  t.mock.method(SidecarSession.prototype, 'run', async function* (req: SidecarJobRequest) {
    requests.push(req);
    const jobId = req.jobId;
    const at = new Date().toISOString();
    const image = decode(new Uint8Array(await fs.readFile(String(req.params.imagePath))));
    const alpha = image.data.filter((_, i) => i % 4 === 3);
    if (req.kind === 'rembg') {
      const cutout = join(String(req.params.outDir), 'cutout.png');
      const data = new Uint8Array(image.data);
      if (removeBackground) data[3] = 0;
      await fs.mkdir(String(req.params.outDir), { recursive: true });
      await fs.writeFile(cutout, encode({ width: 8, height: 8, data }));
      yield { t: 'artifact', jobId, at, kind: 'cutout', path: cutout } as JobEvent;
      yield { t: 'done', jobId, at, wallTimeS: 0 } as JobEvent;
      return;
    }
    if (image.channels !== 4 || alpha.every((a) => a === 255)) {
      yield {
        t: 'error',
        jobId,
        at,
        code: 'bad-input',
        retryable: false,
        message: 'Pixal3D needs a cut-out RGBA image. Run `spritebook prep` first.',
      } as JobEvent;
      return;
    }
    for (let i = 0; i < Number(req.params.candidates); i++) {
      const path = join(String(req.params.outDir), `raw-${i}.glb`);
      await fs.copyFile(
        fileURLToPath(new URL('../importer/fixtures/skinned-column.glb', import.meta.url)),
        path,
      );
      yield { t: 'artifact', jobId, at, kind: 'mesh-raw', path } as JobEvent;
    }
    yield { t: 'done', jobId, at, wallTimeS: 0 } as JobEvent;
  });
  const workspace = join(root, 'character');
  const opts = {
    jobId: 'gen',
    characterId: 'hero' as never,
    workspace,
    imagePath: image,
    modelId: 'fixture-gen',
    seed: 7,
    candidates: 2,
    params: { steps: 16, decimationTarget: 800000 },
    sidecarDir: fileURLToPath(new URL('../../sidecar', import.meta.url)),
    modelsRoot,
    catalogPath,
    detectedVramGb: 24,
  };
  const events = await Array.fromAsync(runGenJob(opts));
  assert(!events.some((e) => e.t === 'error'), JSON.stringify(events.find((e) => e.t === 'error')));
  assertEquals(events.at(-1)?.t, 'done');
  assertEquals(requests.map((r) => r.kind), ['rembg', 'fixture-gen']);
  assertEquals(requests[1]!.params.steps, 16);
  assertEquals(requests[1]!.params.candidates, 2);
  assertEquals(requests[1]!.params.decimationTarget, 800000);
  assertEquals(
    new Uint8Array(await fs.readFile(image)),
    original,
    'the uploaded image is untouched',
  );
  const manifest = await readWorkspace(workspace);
  assertEquals(manifest.generation.results.length, 2);
  assertEquals(manifest.source.sha256, await sha256Hex(original));
  assertEquals(manifest.source.prepared?.backend, { modelId: 'rembg-u2net', version: '1.0.0' });
  const cutout = sourceImagePath(workspace, manifest);
  const prepared = await fs.readFile(cutout);
  assertEquals(manifest.source.prepared?.sha256, await sha256Hex(prepared));
  assertEquals(
    new Uint8Array(
      await fs.readFile(`${workspacePaths(workspace).sourceDir}/${manifest.source.sha256}.png`),
    ),
    original,
  );

  // Undo/redo addresses the source pointer, retaining both files like every other asset edit.
  for (let i = 0; i < 3; i++) await moveManifestCursor(workspacePaths(workspace).manifest, 'undo');
  assertEquals((await readWorkspace(workspace)).source.prepared, undefined);
  for (let i = 0; i < 3; i++) await moveManifestCursor(workspacePaths(workspace).manifest, 'redo');
  assertEquals(sourceImagePath(workspace, await readWorkspace(workspace)), cutout);

  requests.length = 0;
  const retry = await Array.fromAsync(runGenJob({ ...opts, seed: 8 }));
  assertEquals(retry.at(-1)?.t, 'done', JSON.stringify(retry.at(-1)));
  assertEquals(requests.map((r) => r.kind), ['fixture-gen'], 'retry reuses the verified cutout');

  await fs.writeFile(cutout, 'interrupted or corrupt cutout');
  requests.length = 0;
  const repaired = await Array.fromAsync(runGenJob({ ...opts, seed: 9 }));
  assertEquals(repaired.at(-1)?.t, 'done', JSON.stringify(repaired.at(-1)));
  assertEquals(requests.map((r) => r.kind), ['rembg', 'fixture-gen']);
  assertEquals(await fs.readFile(cutout), prepared, 'a damaged cached cutout is regenerated');

  const emptyModels = join(root, 'missing-prep');
  await Array.fromAsync(
    runInstallJob({ jobId: 'install', root: emptyModels, catalog, modelId: 'fixture-gen' }),
  );
  requests.length = 0;
  const missing = await Array.fromAsync(
    runGenJob({ ...opts, workspace: join(root, 'missing'), modelsRoot: emptyModels }),
  );
  const error = missing.find((e) => e.t === 'error');
  assert(
    error?.t === 'error' && error.code === 'model-missing' &&
      error.message.includes('Manage models'),
  );
  assertEquals(requests.length, 0, 'missing prep is refused before any model is run or downloaded');

  const transparent = await Array.fromAsync(
    runGenJob({
      ...opts,
      workspace: join(root, 'transparent'),
      modelsRoot: emptyModels,
      imagePath: cutout,
    }),
  );
  assertEquals(transparent.at(-1)?.t, 'done', JSON.stringify(transparent.at(-1)));
  assertEquals(requests.map((r) => r.kind), ['fixture-gen'], 'a cutout needs no prep model');

  removeBackground = false;
  requests.length = 0;
  const noop = await Array.fromAsync(runGenJob({ ...opts, workspace: join(root, 'noop') }));
  assert(noop.some((e) => e.t === 'error' && e.code === 'invalid-cutout'));
  assertEquals(
    requests.map((r) => r.kind),
    ['rembg'],
    'an opaque prep output never reaches generation',
  );
});
