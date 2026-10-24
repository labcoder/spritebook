import { runProcess } from '../../tools/testing/process.ts';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * P3-T2 generation acceptance, end to end on the REAL sidecar (gated on uv +
 * the sidecar checkout). The roadmap sentence, tested literally:
 *
 *   "a gen run on a fixture image yields a canonical textured glb through the
 *    P1 border with full provenance"
 *
 * plus the verbs around it: one result by default, `--more-like` reusing a
 * receipt's params with a fresh seed, `--adjust` rejected core-side BEFORE a
 * process is spawned, and `pick --reproject` repainting the picked mesh and
 * re-pinning the hash to the bytes actually on disk.
 *
 * The backend is `fixture-gen` — synthetic and weightless, so this whole file
 * runs on any machine with no GPU and no download, which is exactly why it
 * exists.
 */
import { assert, assertEquals } from '@std/assert';
import { encode as encodePng } from 'fast-png';
import { NodeIO } from '@gltf-transform/core';
import { CharacterManifestSchema, parseWith } from '@spritebook/schema';
import type { JobEvent } from '@spritebook/schema';
import { runInstallJob } from '@spritebook/registry';
import { loadCatalog } from '@spritebook/registry';
import { applyPatchOps, workspacePaths } from '@spritebook/core';
import { runGenJob, runPickJob } from './dist/mod.js';

const SIDECAR_DIR = decodeURIComponent(
  new URL('../../sidecar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
);

async function sidecarAvailable(): Promise<boolean> {
  try {
    await fs.stat(`${SIDECAR_DIR}/pyproject.toml`);
    const uv = await runProcess('uv', ['--version']);
    return uv.success;
  } catch {
    return false;
  }
}

/** A deterministic cut-out: an opaque figure-ish blob on transparent black. */
function cutout(w = 128, h = 192): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  const inBody = (x: number, y: number) => {
    const cx = w / 2;
    if (y < h * 0.22) return Math.hypot(x - cx, y - h * 0.13) < w * 0.16; // head
    if (y < h * 0.68) return Math.abs(x - cx) < w * 0.26; // torso + arms
    return Math.abs(x - cx) < w * 0.18; // legs
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = (y * w + x) * 4;
      if (!inBody(x, y)) continue;
      // a deterministic pattern so reprojection has something to carry
      data[at] = (x * 2) % 256;
      data[at + 1] = (y * 3) % 256;
      data[at + 2] = 180;
      data[at + 3] = 255;
    }
  }
  return data;
}

/** `asset.generator` straight out of a .glb's JSON chunk. */
function generatorOf(glb: Uint8Array): string {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  return json.asset?.generator ?? '';
}

async function collect(it: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function artifact(events: JobEvent[], kind: string): string {
  const e = events.find((x) => x.t === 'artifact' && x.kind === kind);
  assert(e, `expected a ${kind} artifact; got ${JSON.stringify(events.at(-1))}`);
  return (e as { path: string }).path;
}

/** Install the weightless fixture backend into a throwaway models root. */
async function installFixtureBackend(root: string): Promise<void> {
  const events = await collect(runInstallJob({
    jobId: 'itest-install',
    catalog: await loadCatalog(),
    root,
    modelId: 'fixture-gen',
  }));
  assertEquals(events.at(-1)?.t, 'done', `fixture-gen install: ${JSON.stringify(events.at(-1))}`);
}

interface Fixture {
  root: string;
  workspace: string;
  image: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Fixture> {
  const root = await fs.mkdtemp(join(tmpdir(), 'sb-gen-models-'));
  const work = await fs.mkdtemp(join(tmpdir(), 'sb-gen-'));
  await installFixtureBackend(root);
  const image = `${work}/cutout.png`;
  await fs.writeFile(image, encodePng({ width: 128, height: 192, data: cutout() }));
  return {
    root,
    workspace: `${work}/character`,
    image,
    cleanup: async () => {
      await fs.rm(root, { recursive: true });
      await fs.rm(work, { recursive: true });
    },
  };
}

const genOpts = (f: Fixture, over: Record<string, unknown> = {}) => ({
  jobId: 'itest-gen',
  characterId: 'hero' as never,
  workspace: f.workspace,
  imagePath: f.image,
  modelId: 'fixture-gen',
  seed: 7,
  params: {},
  modelsRoot: f.root,
  sidecarDir: SIDECAR_DIR,
  ...over,
});

test('ACCEPTANCE: image -> gen -> canonical textured glb with full provenance', async (t) => {
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar unavailable');
    return;
  }
  const f = await setup();
  try {
    const events = await collect(runGenJob(genOpts(f)));
    const err = events.find((e) => e.t === 'error');
    assert(!err, `gen failed: ${JSON.stringify(err)}`);
    assertEquals(events.at(-1)?.t, 'done');

    // the canonical model exists, is a real textured mesh, and came through
    // the border (which writes a preflight report beside it)
    const modelPath = artifact(events, 'gen-model');
    const rawPath = artifact(events, 'gen-raw');
    const preflightPath = artifact(events, 'gen-preflight');
    const bytes = new Uint8Array(await fs.readFile(modelPath));
    const doc = await new NodeIO().readBinary(bytes);
    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    assert(prim.getAttribute('POSITION')!.getCount() > 3, 'the mesh has vertices');
    assert(prim.getAttribute('TEXCOORD_0'), 'the mesh is UV-mapped');
    assert(
      doc.getRoot().listMaterials()[0]?.getBaseColorTexture(),
      'the canonical mesh carries a base color texture',
    );
    // The border's fingerprint, read from the BYTES rather than through
    // glTF-Transform: the library overwrites asset.generator on read AND on
    // write, so a parsed Document always reports the library's own string and
    // could never witness this (that is exactly how the border shipped
    // unstamped from P1-T4 until now).
    assertEquals(
      generatorOf(bytes),
      'spritebook-import@0.1.1',
      'the canonical file itself declares who made it',
    );
    const preflight = JSON.parse(await fs.readFile(preflightPath, 'utf8'));
    assert(Array.isArray(preflight.checks) && preflight.checks.length > 0, 'preflight recorded');
    // raw.glb is kept beside the canonical one, on purpose
    assert((await fs.stat(rawPath)).size > 0, 'the backend output is retained');

    // FULL PROVENANCE: the receipt pins the CANONICAL bytes and can re-run
    const manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await fs.readFile(artifact(events, 'character-manifest'), 'utf8')),
      'CharacterManifest',
    );
    assertEquals(manifest.generation.results.length, 1, 'gen defaults to ONE result');
    const receipt = manifest.generation.results[0];
    assertEquals(receipt.id, 'r1');
    assertEquals(receipt.backend.modelId, 'fixture-gen');
    assertEquals(receipt.seed, 7);
    assertEquals(receipt.discarded, false);
    assert(receipt.output.tris > 0, 'triangle count recorded');
    assert(receipt.output.textureRes! > 0, 'texture resolution recorded');
    // measured from the canonical bytes, not assumed: this is what lets `pick`
    // compare siblings, and the fixture backend emits one solid
    assertEquals(receipt.output.bodies, 1, 'body-sized shells recorded on the receipt');
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    assertEquals(
      receipt.output.gltfSha256,
      hex,
      'the receipt pins the CANONICAL bytes on disk, not the raw backend output',
    );
  } finally {
    await f.cleanup();
  }
});

test('ACCEPTANCE: the same seed reproduces the same canonical bytes', async (t) => {
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar unavailable');
    return;
  }
  const a = await setup();
  const b = await setup();
  try {
    const ea = await collect(runGenJob(genOpts(a)));
    const eb = await collect(runGenJob(genOpts(b)));
    assert(!ea.find((e) => e.t === 'error') && !eb.find((e) => e.t === 'error'));
    assertEquals(
      new Uint8Array(await fs.readFile(artifact(ea, 'gen-model'))),
      new Uint8Array(await fs.readFile(artifact(eb, 'gen-model'))),
      'seed 7 twice -> byte-identical canonical glb (the receipt can re-run it)',
    );
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test('ACCEPTANCE: a different seed produces a different mesh', async (t) => {
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar unavailable');
    return;
  }
  const f = await setup();
  try {
    const first = await collect(runGenJob(genOpts(f)));
    const second = await collect(runGenJob(genOpts(f, { seed: 8, jobId: 'itest-gen2' })));
    assert(!second.find((e) => e.t === 'error'), JSON.stringify(second.at(-1)));
    const one = new Uint8Array(await fs.readFile(artifact(first, 'gen-model')));
    const two = new Uint8Array(await fs.readFile(artifact(second, 'gen-model')));
    assert(
      one.length !== two.length || !one.every((v, i) => v === two[i]),
      'seed 8 differs from seed 7 - "more like this" actually explores',
    );
    const manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await fs.readFile(artifact(second, 'character-manifest'), 'utf8')),
      'CharacterManifest',
    );
    assertEquals(manifest.generation.results.map((r) => r.id), ['r1', 'r2'], 'ids never reused');
  } finally {
    await f.cleanup();
  }
});

test('ACCEPTANCE: invalid --adjust params are refused core-side, no backend run', async (t) => {
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar unavailable');
    return;
  }
  const f = await setup();
  try {
    // textureSize 999 is not in the entry's enum, and tris is over maximum
    const events = await collect(
      runGenJob(genOpts(f, { params: { textureSize: 999 } })),
    );
    const err = events.at(-1);
    assert(err?.t === 'error', 'invalid params must fail');
    if (err.t === 'error') {
      assertEquals(err.code, 'invalid-params');
      assert(err.message.includes('textureSize'), err.message);
    }
    // nothing was generated: no workspace results, no manifest mutation
    let results = 0;
    try {
      for await (const _ of await fs.readdir(`${f.workspace}/results`, { withFileTypes: true })) {
        results++;
      }
    } catch {
      // no results dir at all is the strongest form of "nothing ran"
    }
    assertEquals(results, 0, 'the backend never ran');
  } finally {
    await f.cleanup();
  }
});

test('ACCEPTANCE: pick preserves the candidate unless texture changes are requested', async (t) => {
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar unavailable');
    return;
  }
  const f = await setup();
  try {
    const gen = await collect(runGenJob(genOpts(f)));
    assert(!gen.find((e) => e.t === 'error'), JSON.stringify(gen.at(-1)));

    // Saving a candidate must preserve the model the user inspected.
    const picked = await collect(
      runPickJob({ jobId: 'itest-pick', workspace: f.workspace, resultId: 'r1' }),
    );
    assert(!picked.find((e) => e.t === 'error'), JSON.stringify(picked.at(-1)));
    const canonicalPath = artifact(picked, 'canonical-model');
    let manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await fs.readFile(artifact(picked, 'character-manifest'), 'utf8')),
      'CharacterManifest',
    );
    assertEquals(manifest.generation.pickedResultId, 'r1');
    assertEquals(
      new Uint8Array(await fs.readFile(canonicalPath)),
      new Uint8Array(await fs.readFile(artifact(gen, 'gen-model'))),
      'a default pick preserves the inspected candidate, including its texture',
    );
    assertEquals(manifest.canonicalMesh?.reprojected, false);
    assertEquals(manifest.canonicalMesh?.colorMatched, undefined);
    assertEquals(manifest.canonicalMesh?.imageSha256, undefined);

    // Existing opt-out flags take precedence, even over an explicit opt-in.
    const plain = await collect(
      runPickJob({
        jobId: 'itest-plain',
        workspace: f.workspace,
        resultId: 'r1',
        colorMatch: true,
        reproject: true,
        noColorMatch: true,
        noReproject: true,
      }),
    );
    assert(!plain.find((e) => e.t === 'error'), JSON.stringify(plain.at(-1)));
    assertEquals(
      new Uint8Array(await fs.readFile(canonicalPath)),
      new Uint8Array(await fs.readFile(artifact(gen, 'gen-model'))),
      'pick --no-color-match --no-reproject is a byte copy',
    );
    manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await fs.readFile(artifact(plain, 'character-manifest'), 'utf8')),
      'CharacterManifest',
    );
    const beforeHash = manifest.canonicalMesh!.gltfSha256;

    // Explicit texture changes repaint the canonical asset and record provenance.
    const re = await collect(
      runPickJob({
        jobId: 'itest-reproject',
        workspace: f.workspace,
        resultId: 'r1',
        reproject: true,
        colorMatch: true,
      }),
    );
    assert(!re.find((e) => e.t === 'error'), JSON.stringify(re.at(-1)));
    const after = new Uint8Array(await fs.readFile(canonicalPath));
    manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await fs.readFile(artifact(re, 'character-manifest'), 'utf8')),
      'CharacterManifest',
    );
    assertEquals(manifest.canonicalMesh?.reprojected, true);
    assertEquals(manifest.canonicalMesh?.colorMatched, true);
    assertEquals(manifest.canonicalMesh?.imageSha256, manifest.source.sha256);
    assert(manifest.canonicalMesh!.gltfSha256 !== beforeHash, 'reprojection changed the bytes');
    const digest = await crypto.subtle.digest('SHA-256', after as BufferSource);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    assertEquals(
      manifest.canonicalMesh!.gltfSha256,
      hex,
      'the manifest pins the bytes that are ACTUALLY on disk after reprojection',
    );
    const savedManifest = await fs.readFile(`${f.workspace}/character.json`, 'utf8');
    for (const request of [{ reproject: true }, { colorMatch: true }]) {
      const failed = await collect(runPickJob({
        jobId: 'itest-missing-image',
        workspace: f.workspace,
        resultId: 'r1',
        imagePath: `${f.workspace}/missing.png`,
        ...request,
      }));
      assert(failed.some((e) => e.t === 'error' && e.code === 'no-source'));
      assertEquals(new Uint8Array(await fs.readFile(canonicalPath)), after);
      assertEquals(await fs.readFile(`${f.workspace}/character.json`, 'utf8'), savedManifest);
    }
  } finally {
    await f.cleanup();
  }
});

/** The ManifestPatch lines the workspace's journal currently holds. */
async function journalPatches(workspace: string) {
  const text = await fs.readFile(workspacePaths(workspace).journal, 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

test('ACCEPTANCE: pick --reproject is ONE patch, so ONE undo is coherent', async (t) => {
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar unavailable');
    return;
  }
  const f = await setup();
  try {
    const gen = await collect(runGenJob(genOpts(f)));
    assert(!gen.find((e) => e.t === 'error'), JSON.stringify(gen.at(-1)));
    const before = (await journalPatches(f.workspace)).length;

    const picked = await collect(
      runPickJob({
        jobId: 'itest-pick',
        workspace: f.workspace,
        resultId: 'r1',
        reproject: true,
      }),
    );
    assert(!picked.find((e) => e.t === 'error'), JSON.stringify(picked.at(-1)));

    // promote + repaint + record is ONE step, so it is ONE journal line: a
    // second patch makes `spritebook undo` pop half of it
    const patches = await journalPatches(f.workspace);
    assertEquals(
      patches.length - before,
      1,
      `one step is one patch (labels: ${patches.slice(before).map((p) => p.label).join(', ')})`,
    );

    // ...and popping it undoes the WHOLE pick, rather than leaving a manifest
    // that pins the pre-reproject sha for bytes that were repainted
    const doc = JSON.parse(await fs.readFile(workspacePaths(f.workspace).manifest, 'utf8'));
    const undone = applyPatchOps(doc, patches[patches.length - 1].inverse);
    const restored = parseWith(CharacterManifestSchema, undone, 'undone CharacterManifest');
    assertEquals(restored.generation.pickedResultId, undefined, 'the pick came off');
    assertEquals(restored.canonicalMesh, undefined, 'and so did the hash it pinned');

    // the staging temps do not outlive the step
    const strays: string[] = [];
    for await (
      const e of await fs.readdir(workspacePaths(f.workspace).canonicalDir, { withFileTypes: true })
    ) {
      if (e.name.includes('.tmp.')) strays.push(e.name);
    }
    assertEquals(strays, [], 'no staging temps left in canonical/');
  } finally {
    await f.cleanup();
  }
});

test('gen says so when nobody declared what size the character is', async (t) => {
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar unavailable');
    return;
  }
  const f = await setup();
  try {
    // Without --height the border does not rescale, so the mesh keeps whatever
    // scale the backend chose. Everything downstream believes that number:
    // `bake` frames in pixelsPerMeter, and the P3 exit measurement watched a
    // 1 m character land ~20 px tall in a 64 px cell, where its own outline
    // swallowed 81% of the silhouette and the sprite shipped nearly black.
    const quiet = await collect(runGenJob(genOpts(f)));
    const warn = quiet.find((e) => e.t === 'warn' && e.code === 'scale-undeclared');
    assert(warn, `expected the warning; got ${quiet.filter((e) => e.t === 'warn').length} warns`);
    const message = (warn as { message: string }).message;
    assert(/\d+\.\d+ m tall/.test(message), `it names the measured height: ${message}`);
    assert(/--height/.test(message), `and the flag that fixes it: ${message}`);

    // ...and stays quiet when the caller DID say. A warning that fires either
    // way trains people to ignore it.
    const g = await setup();
    try {
      const told = await collect(runGenJob(genOpts(g, { declaredHeightM: 1.7 })));
      assert(
        !told.find((e) => e.t === 'warn' && e.code === 'scale-undeclared'),
        'no warning when --height was given',
      );
    } finally {
      await g.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

test('ACCEPTANCE: gen --candidates makes N receipts and ranks them', async (t) => {
  if (!(await sidecarAvailable())) {
    t.skip('uv or sidecar unavailable');
    return;
  }
  const f = await setup();
  try {
    const events = await collect(runGenJob(genOpts(f, { candidates: 3 })));
    const err = events.find((e) => e.t === 'error');
    assert(!err, `candidates gen failed: ${JSON.stringify(err)}`);

    const manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await fs.readFile(artifact(events, 'character-manifest'), 'utf8')),
      'CharacterManifest',
    );
    assertEquals(
      manifest.generation.results.map((r) => r.id),
      ['r1', 'r2', 'r3'],
      'every candidate becomes a receipt',
    );
    // the stride convention: candidate i requested seed + i*1000 (fixture-gen
    // emits no gen-meta, so the recorded seed IS the convention's fallback)
    assertEquals(manifest.generation.results.map((r) => r.seed), [7, 1007, 2007]);
    // three distinct meshes, each with its own canonical bytes
    assertEquals(
      new Set(manifest.generation.results.map((r) => r.output.gltfSha256)).size,
      3,
      'three candidates are three different canonical meshes',
    );
    for (const id of ['r1', 'r2', 'r3']) {
      const rp = `${f.workspace}/results/${id}`;
      assert((await fs.stat(`${rp}/raw.glb`)).size > 0, `${id} kept its raw`);
      assert((await fs.stat(`${rp}/model.glb`)).size > 0, `${id} has a canonical model`);
    }
    // nothing was picked FOR the user; the ranking is a suggestion
    assertEquals(manifest.generation.pickedResultId, undefined);
    const ranked = events.find((e) => e.t === 'warn' && e.code === 'candidates-ranked');
    assert(ranked && ranked.t === 'warn', 'a ranking was suggested');
    assert(/pick --result r\d/.test(ranked.message), `it names a pick: ${ranked.message}`);
    assert(/bodies|body/.test(ranked.message), `and shows the signals: ${ranked.message}`);
  } finally {
    await f.cleanup();
  }
});
