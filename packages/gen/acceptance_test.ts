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
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { encode as encodePng } from 'fast-png';
import { NodeIO } from '@gltf-transform/core';
import { CharacterManifestSchema, parseWith } from '@spritebook/schema';
import type { JobEvent } from '@spritebook/schema';
import { runInstallJob } from '@spritebook/registry';
import { loadCatalog } from '@spritebook/registry';
import { applyPatchOps, workspacePaths } from '@spritebook/core';
import { runGenJob, runPickJob } from './mod.ts';

const SIDECAR_DIR = decodeURIComponent(
  new URL('../../sidecar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
);

async function sidecarAvailable(): Promise<boolean> {
  try {
    await Deno.stat(`${SIDECAR_DIR}/pyproject.toml`);
    const uv = await new Deno.Command('uv', {
      args: ['--version'],
      stdout: 'null',
      stderr: 'null',
      stdin: 'null',
    }).output();
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
  const root = await Deno.makeTempDir({ prefix: 'sb-gen-models-' });
  const work = await Deno.makeTempDir({ prefix: 'sb-gen-' });
  await installFixtureBackend(root);
  const image = `${work}/cutout.png`;
  await Deno.writeFile(image, encodePng({ width: 128, height: 192, data: cutout() }));
  return {
    root,
    workspace: `${work}/character`,
    image,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(work, { recursive: true });
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

Deno.test('ACCEPTANCE: image -> gen -> canonical textured glb with full provenance', async () => {
  if (!(await sidecarAvailable())) {
    console.log('skip: uv or sidecar/ not available');
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
    const bytes = await Deno.readFile(modelPath);
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
      'spritebook-import@0.1.0',
      'the canonical file itself declares who made it',
    );
    const preflight = JSON.parse(await Deno.readTextFile(preflightPath));
    assert(Array.isArray(preflight.checks) && preflight.checks.length > 0, 'preflight recorded');
    // raw.glb is kept beside the canonical one, on purpose
    assert((await Deno.stat(rawPath)).size > 0, 'the backend output is retained');

    // FULL PROVENANCE: the receipt pins the CANONICAL bytes and can re-run
    const manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await Deno.readTextFile(artifact(events, 'character-manifest'))),
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

Deno.test('ACCEPTANCE: the same seed reproduces the same canonical bytes', async () => {
  if (!(await sidecarAvailable())) return;
  const a = await setup();
  const b = await setup();
  try {
    const ea = await collect(runGenJob(genOpts(a)));
    const eb = await collect(runGenJob(genOpts(b)));
    assert(!ea.find((e) => e.t === 'error') && !eb.find((e) => e.t === 'error'));
    assertEquals(
      await Deno.readFile(artifact(ea, 'gen-model')),
      await Deno.readFile(artifact(eb, 'gen-model')),
      'seed 7 twice -> byte-identical canonical glb (the receipt can re-run it)',
    );
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

Deno.test('ACCEPTANCE: a different seed produces a different mesh', async () => {
  if (!(await sidecarAvailable())) return;
  const f = await setup();
  try {
    const first = await collect(runGenJob(genOpts(f)));
    const second = await collect(runGenJob(genOpts(f, { seed: 8, jobId: 'itest-gen2' })));
    assert(!second.find((e) => e.t === 'error'), JSON.stringify(second.at(-1)));
    const one = await Deno.readFile(artifact(first, 'gen-model'));
    const two = await Deno.readFile(artifact(second, 'gen-model'));
    assert(
      one.length !== two.length || !one.every((v, i) => v === two[i]),
      'seed 8 differs from seed 7 - "more like this" actually explores',
    );
    const manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await Deno.readTextFile(artifact(second, 'character-manifest'))),
      'CharacterManifest',
    );
    assertEquals(manifest.generation.results.map((r) => r.id), ['r1', 'r2'], 'ids never reused');
  } finally {
    await f.cleanup();
  }
});

Deno.test('ACCEPTANCE: invalid --adjust params are refused core-side, no backend run', async () => {
  if (!(await sidecarAvailable())) return;
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
      for await (const _ of Deno.readDir(`${f.workspace}/results`)) results++;
    } catch {
      // no results dir at all is the strongest form of "nothing ran"
    }
    assertEquals(results, 0, 'the backend never ran');
  } finally {
    await f.cleanup();
  }
});

Deno.test('ACCEPTANCE: pick --reproject repaints and re-pins the canonical hash', async () => {
  if (!(await sidecarAvailable())) return;
  const f = await setup();
  try {
    const gen = await collect(runGenJob(genOpts(f)));
    assert(!gen.find((e) => e.t === 'error'), JSON.stringify(gen.at(-1)));

    // plain pick first: canonical/model.glb is a byte copy of the result
    const picked = await collect(
      runPickJob({ jobId: 'itest-pick', workspace: f.workspace, resultId: 'r1' }),
    );
    assert(!picked.find((e) => e.t === 'error'), JSON.stringify(picked.at(-1)));
    const canonicalPath = artifact(picked, 'canonical-model');
    assertEquals(
      await Deno.readFile(canonicalPath),
      await Deno.readFile(artifact(gen, 'gen-model')),
      'a plain pick is a byte copy',
    );
    let manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await Deno.readTextFile(artifact(picked, 'character-manifest'))),
      'CharacterManifest',
    );
    assertEquals(manifest.generation.pickedResultId, 'r1');
    assertEquals(manifest.canonicalMesh?.reprojected, false);
    const beforeHash = manifest.canonicalMesh!.gltfSha256;

    // now with reprojection: bytes change, and the manifest follows them
    const re = await collect(
      runPickJob({
        jobId: 'itest-reproject',
        workspace: f.workspace,
        resultId: 'r1',
        reproject: true,
      }),
    );
    assert(!re.find((e) => e.t === 'error'), JSON.stringify(re.at(-1)));
    const after = await Deno.readFile(canonicalPath);
    manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await Deno.readTextFile(artifact(re, 'character-manifest'))),
      'CharacterManifest',
    );
    assertEquals(manifest.canonicalMesh?.reprojected, true);
    assert(manifest.canonicalMesh!.gltfSha256 !== beforeHash, 'reprojection changed the bytes');
    const digest = await crypto.subtle.digest('SHA-256', after as BufferSource);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    assertEquals(
      manifest.canonicalMesh!.gltfSha256,
      hex,
      'the manifest pins the bytes that are ACTUALLY on disk after reprojection',
    );
  } finally {
    await f.cleanup();
  }
});

/** The ManifestPatch lines the workspace's journal currently holds. */
async function journalPatches(workspace: string) {
  const text = await Deno.readTextFile(workspacePaths(workspace).journal).catch(() => '');
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

Deno.test('ACCEPTANCE: pick --reproject is ONE patch, so ONE undo is coherent', async () => {
  if (!(await sidecarAvailable())) return;
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
    const doc = JSON.parse(await Deno.readTextFile(workspacePaths(f.workspace).manifest));
    const undone = applyPatchOps(doc, patches[patches.length - 1].inverse);
    const restored = parseWith(CharacterManifestSchema, undone, 'undone CharacterManifest');
    assertEquals(restored.generation.pickedResultId, undefined, 'the pick came off');
    assertEquals(restored.canonicalMesh, undefined, 'and so did the hash it pinned');

    // the staging temps do not outlive the step
    const strays: string[] = [];
    for await (const e of Deno.readDir(workspacePaths(f.workspace).canonicalDir)) {
      if (e.name.includes('.tmp.')) strays.push(e.name);
    }
    assertEquals(strays, [], 'no staging temps left in canonical/');
  } finally {
    await f.cleanup();
  }
});
