/**
 * `retexture`: keep the mesh, reroll the paint — end to end on the real
 * sidecar, with the weightless `fixture-retexture` backend so the whole path
 * runs on a machine with no GPU.
 *
 * What is worth pinning here is not "a file appeared". It is that the SURFACE
 * survived while the paint changed, that the receipt names its parent, and that
 * the backend was found by asking who can retexture rather than by naming one —
 * that last is the promise that makes a second texturing model catalog data
 * instead of a code change.
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { encode as encodePng } from 'fast-png';
import { NodeIO } from '@gltf-transform/core';
import { CharacterManifestSchema, parseWith } from '@spritebook/schema';
import type { JobEvent, ModelEntry } from '@spritebook/schema';
import { loadCatalog, runInstallJob } from '@spritebook/registry';
import { toyEntry, toyVersion } from '../registry/_testutil.ts';
import { retextureBackends, runGenJob, runRetextureJob } from './mod.ts';

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

function cutout(w = 96, h = 144): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.abs(x - w / 2) > w * 0.28) continue;
      const at = (y * w + x) * 4;
      data[at] = (x * 3) % 256;
      data[at + 1] = 90;
      data[at + 2] = (y * 2) % 256;
      data[at + 3] = 255;
    }
  }
  return data;
}

async function collect(it: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** [min, max] of one axis over an interleaved XYZ position array. */
function extent(positions: Float32Array, axis: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = axis; i < positions.length; i += 3) {
    lo = Math.min(lo, positions[i]);
    hi = Math.max(hi, positions[i]);
  }
  return [lo, hi];
}

/** Positions and the base-colour texture bytes of a canonical glb. */
async function meshAndPaint(path: string) {
  const doc = await new NodeIO().read(path);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const positions = prim.getAttribute('POSITION')!.getArray()!;
  const tex = doc.getRoot().listTextures()[0]?.getImage();
  return { positions: Float32Array.from(positions), texture: tex };
}

interface Fixture {
  root: string;
  workspace: string;
  image: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: 'sb-rt-models-' });
  const work = await Deno.makeTempDir({ prefix: 'sb-rt-' });
  const events = await collect(runInstallJob({
    jobId: 'rt-install',
    catalog: await loadCatalog(),
    root,
    modelId: 'fixture-gen',
  }));
  assertEquals(events.at(-1)?.t, 'done', `install: ${JSON.stringify(events.at(-1))}`);
  const image = `${work}/cutout.png`;
  await Deno.writeFile(image, encodePng({ width: 96, height: 144, data: cutout() }));
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

async function genOnce(f: Fixture): Promise<void> {
  const events = await collect(runGenJob({
    jobId: 'rt-gen',
    characterId: 'hero' as never,
    workspace: f.workspace,
    imagePath: f.image,
    modelId: 'fixture-gen',
    seed: 7,
    params: {},
    modelsRoot: f.root,
    sidecarDir: SIDECAR_DIR,
  }));
  const err = events.find((e) => e.t === 'error');
  assert(!err, `gen failed: ${JSON.stringify(err)}`);
}

const rtOpts = (f: Fixture, over: Record<string, unknown> = {}) => ({
  jobId: 'rt-job',
  workspace: f.workspace,
  resultId: 'r1',
  seed: 21,
  modelsRoot: f.root,
  sidecarDir: SIDECAR_DIR,
  ...over,
});

Deno.test('ACCEPTANCE: the surface survives, the paint changes, the parent is named', async () => {
  if (!(await sidecarAvailable())) {
    console.log('skip: uv or sidecar/ not available');
    return;
  }
  const f = await setup();
  try {
    await genOnce(f);
    const before = await meshAndPaint(`${f.workspace}/results/r1/model.glb`);

    const events = await collect(runRetextureJob(rtOpts(f)));
    const err = events.find((e) => e.t === 'error');
    assert(!err, `retexture failed: ${JSON.stringify(err)}`);
    assertEquals(events.at(-1)?.t, 'done');

    const after = await meshAndPaint(`${f.workspace}/results/r2/model.glb`);

    // THE SHARED CONTRACT: the surface does not move. Bounds rather than
    // per-vertex equality, because that is all the real backend promises - it
    // re-encodes and returns ~1.5% more vertices with the faces reordered.
    for (const axis of [0, 1, 2]) {
      const [lo0, hi0] = extent(before.positions, axis);
      const [lo1, hi1] = extent(after.positions, axis);
      const span = hi0 - lo0;
      assert(span > 0, `axis ${axis} has extent`);
      assert(
        Math.abs(lo1 - lo0) / span < 0.01 && Math.abs(hi1 - hi0) / span < 0.01,
        `axis ${axis} moved: [${lo0},${hi0}] -> [${lo1},${hi1}]`,
      );
    }

    // FIXTURE-STRENGTH, and only true here: `fixture-retexture` writes the
    // input's vertex buffer straight back, so it can be compared elementwise.
    // The real backend would fail this, which is why it is labelled.
    assertEquals(after.positions.length, before.positions.length, 'the stand-in keeps the buffer');
    let maxDelta = 0;
    for (let i = 0; i < before.positions.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(after.positions[i] - before.positions[i]));
    }
    assert(maxDelta < 1e-5, `geometry moved by ${maxDelta}`);

    assert(before.texture && after.texture, 'both results carry a base-colour texture');
    assertNotEquals(
      [...before.texture].join(','),
      [...after.texture].join(','),
      'the paint must actually differ - otherwise this verb did nothing',
    );

    // the receipt: a new id, its parent named, and the SEED it ran with
    const manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await Deno.readTextFile(`${f.workspace}/character.json`)),
      'manifest',
    );
    assertEquals(manifest.generation.results.map((r) => r.id), ['r1', 'r2']);
    const r2 = manifest.generation.results[1];
    assertEquals(r2.derivedFrom, 'r1');
    assertEquals(r2.seed, 21);
    assertEquals(r2.discarded, false);
    assertNotEquals(r2.output.gltfSha256, manifest.generation.results[0].output.gltfSha256);
    // r1 is untouched: repainting is additive, never destructive
    assertEquals(manifest.generation.results[0].derivedFrom, undefined);
    assertEquals(manifest.generation.pickedResultId, undefined);
    // and the journal carries it, so `undo` takes the retexture back
    const journal = await Deno.readTextFile(`${f.workspace}/character.json.journal.ndjson`);
    assert(journal.includes('Retexture r1 -> r2'), 'the patch label says what happened');
  } finally {
    await f.cleanup();
  }
});

Deno.test('a different seed paints differently; the same seed reproduces', async () => {
  if (!(await sidecarAvailable())) {
    console.log('skip: uv or sidecar/ not available');
    return;
  }
  const f = await setup();
  try {
    await genOnce(f);
    for (const [id, seed] of [['r2', 21], ['r3', 99], ['r4', 21]] as const) {
      const events = await collect(runRetextureJob(rtOpts(f, { seed })));
      const err = events.find((e) => e.t === 'error');
      assert(!err, `retexture ${id}@${seed} failed: ${JSON.stringify(err)}`);
    }
    const manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await Deno.readTextFile(`${f.workspace}/character.json`)),
      'manifest',
    );
    const [, r2, r3, r4] = manifest.generation.results;
    assertNotEquals(r2.output.gltfSha256, r3.output.gltfSha256, 'a different seed, a new texture');
    assertEquals(r4.output.gltfSha256, r2.output.gltfSha256, 'the same seed reproduces exactly');
    // every one of them repaints the ORIGINAL, not the previous repaint
    assertEquals([r2, r3, r4].map((r) => r.derivedFrom), ['r1', 'r1', 'r1']);
  } finally {
    await f.cleanup();
  }
});

Deno.test('refusals name what is wrong and what could work', async () => {
  if (!(await sidecarAvailable())) {
    console.log('skip: uv or sidecar/ not available');
    return;
  }
  const f = await setup();
  try {
    await genOnce(f);
    const errorOf = async (over: Record<string, unknown>) => {
      const events = await collect(runRetextureJob(rtOpts(f, over)));
      const e = events.find((x) => x.t === 'error');
      assert(e, `expected a refusal for ${JSON.stringify(over)}`);
      return e as { code: string; message: string };
    };

    const missing = await errorOf({ resultId: 'r9' });
    assertEquals(missing.code, 'no-such-result');
    assert(missing.message.includes('r1'), `names what IS there: ${missing.message}`);

    const wrongBackend = await errorOf({ modelId: 'unirig' });
    assertEquals(wrongBackend.code, 'no-backend');
    assert(
      wrongBackend.message.includes('fixture-gen'),
      `names a backend that can: ${wrongBackend.message}`,
    );

    // the parent's mesh can be deleted while its receipt survives
    await Deno.remove(`${f.workspace}/results/r1/model.glb`);
    const gone = await errorOf({});
    assertEquals(gone.code, 'no-parent-mesh');
  } finally {
    await f.cleanup();
  }
});

Deno.test('the backend is chosen by capability, and the parent wins ties', () => {
  const painter = (id: string): ModelEntry =>
    toyEntry({
      id,
      kind: 'gen3d',
      versions: [toyVersion({
        capabilities: ['gen3d', 'retexture'],
        outputs: { geometry: true, texture: true, kind: 'mesh' },
      })],
    });
  const models = [
    painter('alpha'),
    toyEntry({ id: 'rigger' }), // rig-only: never a candidate
    painter('omega'),
  ];
  assertEquals(retextureBackends(models).map((c) => c.entry.id), ['alpha', 'omega']);
  // a mesh is best re-encoded by the model that made it, so its own backend
  // sorts first even when it is not first in the catalog
  assertEquals(retextureBackends(models, 'omega').map((c) => c.entry.id), ['omega', 'alpha']);
  // and a preference for something that cannot paint changes nothing
  assertEquals(retextureBackends(models, 'rigger').map((c) => c.entry.id), ['alpha', 'omega']);
  assertEquals(retextureBackends([toyEntry({ id: 'rigger' })]).length, 0);
});

Deno.test('the bundled catalog can actually retexture', async () => {
  // the unit test above proves the RULE; this proves the catalog satisfies it,
  // which is the half that breaks when an entry is edited
  const cat = await loadCatalog();
  const ids = retextureBackends(cat.models).map((c) => c.entry.id);
  assert(ids.includes('fixture-gen'), `the GPU-free stand-in can retexture: ${ids}`);
  assert(ids.includes('trellis2-4b'), `and the real backend can: ${ids}`);
});
