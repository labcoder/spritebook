import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli/dist/mod.js';
import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { fileURLToPath } from 'node:url';
import { CharacterIdSchema, type ModelCatalog, type ProjectPins } from '@spritebook/schema';
import { loadCatalog } from './dist/catalog.js';
import { runInstallJob } from './dist/install.js';
import { resolveInstalled } from './dist/installed.js';
import { writePins } from './dist/pins.js';
import {
  executionVram,
  resolvePinnedInstalled,
  verifyExecutionModel,
  verifyPackPin,
} from './dist/execution.js';
import { collect, installRig } from './_testutil.ts';
import { runGenJob } from '../gen/dist/gen.js';
import { readWorkspace } from '../core/workspace.ts';

const pins: ProjectPins = {
  models: { 'fixture-gen': '1.0.0' },
  packs: { ual: '1+2' },
  rendererVersion: 'legacy',
};

test('project pins select the exact installed recipe and corrupt weights refuse before sidecar work', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    const catalog = await loadCatalog();
    const entry = catalog.models.find((m) => m.id === 'fixture-gen')!;
    const version = entry.versions[0];
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    version.files = [{
      path: 'weight.bin',
      url: 'https://fixture.invalid/weight',
      bytes: 3,
      sha256: sha,
    }];
    entry.versions.push({ ...structuredClone(version), version: '2.0.0' });
    const small: ModelCatalog = { ...catalog, models: [entry] };
    const models = `${root}/models`, workspace = `${root}/hero`;
    const catalogPath = `${root}/catalog.json`;
    await fs.writeFile(catalogPath, JSON.stringify(small));
    for (const version of ['1.0.0', '2.0.0']) {
      const events = await collect(
        runInstallJob({
          jobId: 'install',
          root: models,
          catalog: small,
          modelId: 'fixture-gen',
          version,
          detected: { platform: 'windows-cpu', vramGb: null },
          fetcher: async (_url, path) => {
            await fs.writeFile(path, bytes);
          },
        }),
      );
      assertEquals(events.at(-1)?.t, 'done');
    }
    await writePins(`${root}/pins.json`, pins);
    assertEquals((await resolveInstalled(models, entry.id))?.version, '2.0.0');
    assertEquals(
      (await resolvePinnedInstalled(models, entry.id, undefined, { workspace }))?.version,
      '1.0.0',
    );
    await assertRejects(
      () => resolvePinnedInstalled(models, entry.id, '2.0.0', { workspace }),
      Error,
      'Project pins require',
    );
    const opts = {
      jobId: 'gen',
      workspace,
      characterId: CharacterIdSchema.parse('hero'),
      modelId: 'fixture-gen',
      params: {},
      seed: 7,
      imagePath: fileURLToPath(new URL('../../tests/fixtures/bulma-front.png', import.meta.url)),
      sidecarDir: fileURLToPath(new URL('../../sidecar', import.meta.url)),
      modelsRoot: models,
      catalogPath,
    };
    assertEquals((await collect(runGenJob(opts))).at(-1)?.t, 'done');
    let accepted = await readWorkspace(workspace);
    assertEquals(
      accepted.generation.results[0].backend.version,
      '1.0.0',
      'actual output receipt uses the pin, not newest',
    );
    await fs.rm(`${root}/pins.json`);
    const replay: string[] = [];
    assertEquals(
      await runCli([
        'gen',
        '--workspace',
        workspace,
        '--character',
        'hero',
        '--more-like',
        'r1',
        '--models-dir',
        models,
        '--catalog',
        catalogPath,
        '--sidecar',
        opts.sidecarDir,
        '--json',
      ], { stdout: (line) => replay.push(line), stderr: (line) => replay.push(line) }),
      0,
      replay.join('\n'),
    );
    accepted = await readWorkspace(workspace);
    assertEquals(
      accepted.generation.results.at(-1)?.backend.version,
      '1.0.0',
      'more-like replays the recorded version even without project pins',
    );
    await writePins(`${root}/pins.json`, pins);
    const measured = (await loadCatalog()).models.find((m) => m.id === 'trellis2-4b')!.versions[0];
    const memoryCatalog = structuredClone(small);
    const memoryVersion = memoryCatalog.models[0].versions[0];
    memoryVersion.vramProfiles = measured.vramProfiles;
    memoryVersion.defaults = { ...memoryVersion.defaults, lowVram: true, pipelineType: '512' };
    memoryVersion.paramsSchema = {
      ...memoryVersion.paramsSchema,
      properties: {
        ...(memoryVersion.paramsSchema.properties as object),
        lowVram: { type: 'boolean' },
        pipelineType: { type: 'string' },
      },
    };
    await fs.writeFile(catalogPath, JSON.stringify(memoryCatalog));
    const memory = (await collect(
      runGenJob({
        ...opts,
        params: { lowVram: false },
        detectedVramGb: 12,
        sidecarDir: `${root}/no-sidecar`,
      }),
    )).at(-1)!;
    assertEquals(
      memory.t === 'error' && memory.code,
      'vram-insufficient',
      'resident config must not borrow the low-memory claim',
    );
    await fs.writeFile(catalogPath, JSON.stringify(small));
    await fs.writeFile(`${models}/fixture-gen/1.0.0/weight.bin`, new Uint8Array([3, 2, 1]));
    const failed = await collect(runGenJob({ ...opts, sidecarDir: `${root}/no-sidecar` }));
    const terminal = failed.at(-1)!;
    assertEquals(terminal.t === 'error' && terminal.code, 'verify-failed');
    assertEquals(
      await readWorkspace(workspace),
      accepted,
      'failed policy cannot append an accepted result',
    );
    await fs.rm(`${models}/fixture-gen/1.0.0/receipt.json`);
    assertEquals(
      await resolvePinnedInstalled(models, entry.id, undefined, { workspace }),
      null,
      'a missing pin cannot fall forward to installed 2.0.0',
    );
    await assertRejects(
      () => verifyPackPin({ id: 'ual', version: 'other' }, { workspace }),
      Error,
      'Project pins require',
    );
    await fs.writeFile(`${root}/pins.json`, 'invalid');
    await assertRejects(
      () => resolvePinnedInstalled(models, entry.id, undefined, { workspace }),
      Error,
      'Cannot use project pins',
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('job-time consent fingerprints, territory and current platform are rechecked', async () => {
  const rig = await installRig({
    license: {
      name: 'Toy license',
      requiresAcceptance: true,
      url: 'https://fixture.invalid/terms',
      excludedTerritories: ['FR'],
    },
  });
  try {
    assertEquals(
      (await collect(
        runInstallJob({
          jobId: 'install',
          catalog: rig.catalog,
          root: rig.root,
          modelId: 'toy-rig',
          version: '1.0',
          acceptLicense: true,
          territory: 'US',
          fetcher: rig.fetcher,
          detected: { platform: 'windows-cpu', vramGb: null },
        }),
      )).at(-1)?.t,
      'done',
    );
    const entry = rig.catalog.models[0], version = entry.versions[0];
    const { receipt } = (await resolveInstalled(rig.root, entry.id, '1.0'))!;
    const opts = {
      root: rig.root,
      catalog: rig.catalog,
      entry,
      version,
      receipt,
      platform: 'windows-cpu' as const,
    };
    await verifyExecutionModel(opts);
    const changed = structuredClone(entry);
    changed.license.url = 'https://fixture.invalid/new-terms';
    await assertRejects(
      () => verifyExecutionModel({ ...opts, entry: changed }),
      Error,
      'no acceptance',
    );
    await assertRejects(
      () => verifyExecutionModel({ ...opts, receipt: { ...receipt, licenseAccepted: null } }),
      Error,
      'no acceptance',
    );
    await assertRejects(
      () => verifyExecutionModel({ ...opts, receipt: { ...receipt, territoryDeclared: 'FR' } }),
      Error,
      'excludes',
    );
    await assertRejects(
      () => verifyExecutionModel({ ...opts, version: { ...version, platforms: ['linux-cuda'] } }),
      Error,
      'this machine is windows-cpu',
    );
  } finally {
    await fs.rm(rig.tmp, { recursive: true });
  }
});

test('VRAM claims follow the measured configuration; unmeasured paths refuse', async () => {
  const catalog = await loadCatalog();
  const version = catalog.models.find((m) => m.id === 'trellis2-4b')!.versions[0];
  assertEquals(executionVram(version, 'gen3d', { lowVram: true, pipelineType: '512' }), 4);
  assertEquals(executionVram(version, 'gen3d', { lowVram: false, pipelineType: '512' }), 18);
  assertEquals(executionVram(version, 'retexture', { lowVram: true, resolution: 1024 }), 8);
  assertThrows(
    () => executionVram(version, 'gen3d', { lowVram: false, pipelineType: '1024' }),
    Error,
    'No measured VRAM profile',
  );
});
