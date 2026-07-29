/**
 * P1-T4 acceptance (CI): double-import determinism (the P1 exit gate),
 * prune supervision, VRM 0.x reorientation, FBX round-trip, actionable errors.
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { getBounds } from '@gltf-transform/core';
import { EventBus, JobQueue, sha256Hex } from '@spritebook/core';
import { JobSpecSchema, parseWith } from '@spritebook/schema';
import { getIO } from './io.ts';
import { ImportError } from './errors.ts';
import { importToCanonical, makeImportExecutor } from './import.ts';

const fx = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function importHash(input: string, declaredHeightM?: number): Promise<string> {
  const { bytes } = await importToCanonical({ input, declaredHeightM });
  return await sha256Hex(new TextDecoder('latin1').decode(bytes));
}

// --- acceptance: double-import determinism (the glTF-Transform tripwire) ----
for (const fixture of ['skinned-column.glb', 'cube.obj', 'rigged-cube.fbx', 'vrm0-arrow.gltf']) {
  Deno.test(`acceptance: double-import of ${fixture} yields identical sha256`, async () => {
    const a = await importHash(fx(fixture), 1.8);
    const b = await importHash(fx(fixture), 1.8);
    assertEquals(a, b);
  });
}

// --- acceptance: prune supervision keeps skins/joints ------------------------
Deno.test('acceptance: skinned fixture keeps skin/joint counts through canonicalization', async () => {
  const { bytes, report } = await importToCanonical({ input: fx('skinned-column.glb') });
  const io = await getIO();
  const doc = await io.readBinary(bytes);
  const skins = doc.getRoot().listSkins();
  assertEquals(skins.length, 1);
  assertEquals(skins[0].listJoints().length, 4, 'P0-T2 column has a 4-joint chain');
  assert(report.checks.some((c) => c.id === 'cleanup' && c.message.includes('1 skins / 4 joints')));
});

// --- acceptance: VRM 0.x faces +Z after import -------------------------------
Deno.test('acceptance: VRM 0.x fixture faces +Z after import (nose flips -Z -> +Z)', async () => {
  const { bytes, report, provenance } = await importToCanonical({ input: fx('vrm0-arrow.gltf') });
  assertEquals(provenance.vrm, 'vrm0');
  const io = await getIO();
  const doc = await io.readBinary(bytes);
  // normalization lives on node transforms + IBMs, so compose world matrices
  // like any glTF consumer would before checking orientation
  const meshNode = doc.getRoot().listNodes().find((n) => n.getMesh())!;
  const world = meshNode.getWorldMatrix();
  const raw = doc.getRoot().listMeshes()[0].listPrimitives()[0]
    .getAttribute('POSITION')!.getArray()! as Float32Array;
  const pos = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const [x, y, z] = [raw[i], raw[i + 1], raw[i + 2]];
    pos[i] = world[0] * x + world[4] * y + world[8] * z + world[12];
    pos[i + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
    pos[i + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
  }
  // the nose is the single |z|-extreme vertex; pre-import it sat at z = -1
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 2; i < pos.length; i += 3) {
    minZ = Math.min(minZ, pos[i]);
    maxZ = Math.max(maxZ, pos[i]);
  }
  const noseCount = countAt(pos, maxZ);
  const tailCount = countAt(pos, minZ);
  assertEquals(noseCount, 1, 'unique nose vertex is at +Z after import');
  assert(tailCount >= 2, 'tail vertices are at -Z after import');
  assert(report.checks.some((c) => c.id === 'orientation' && c.message.includes('180')));
  // the VRM extension is shed at the border - canonical is plain glTF
  assertEquals(doc.getRoot().listExtensionsUsed().length, 0);

  function countAt(arr: Float32Array, z: number): number {
    let n = 0;
    for (let i = 2; i < arr.length; i += 3) if (Math.abs(arr[i] - z) < 1e-5) n++;
    return n;
  }
});

// --- acceptance: FBX round-trips ---------------------------------------------
Deno.test('acceptance: FBX fixture round-trips with skin intact and valid binds', async () => {
  const { bytes, provenance } = await importToCanonical({
    input: fx('rigged-cube.fbx'),
    declaredHeightM: 1.0,
  });
  assertEquals(provenance.tool, 'three-fbx');
  const io = await getIO();
  const doc = await io.readBinary(bytes);
  const skins = doc.getRoot().listSkins();
  assertEquals(skins.length, 1);
  assertEquals(skins[0].listJoints().length, 2, 'root + tip chain');

  // bind validity invariant: joint_world · IBM ≈ I for every joint
  const ibm = skins[0].getInverseBindMatrices()!.getArray()! as Float32Array;
  skins[0].listJoints().forEach((joint, j) => {
    const world = joint.getWorldMatrix();
    const m = multiply4(world, ibm.subarray(j * 16, j * 16 + 16));
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      assert(
        Math.abs(m[i] - expected) < 1e-3,
        `joint ${joint.getName()}: worldBind*IBM deviates at ${i}: ${m[i]}`,
      );
    }
  });

  // conventions: 1 m declared height honored, feet on the ground
  const bounds = getBounds(doc.getRoot().listScenes()[0]);
  assert(Math.abs(bounds.max[1] - bounds.min[1] - 1.0) < 1e-3, 'height rescaled to 1 m');
  assert(Math.abs(bounds.min[1]) < 1e-3, 'feet at Y=0');
});

function multiply4(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

// --- conventions on the skinned glb ------------------------------------------
Deno.test('declared height + feet grounding hold for skinned sources too', async () => {
  const { bytes } = await importToCanonical({
    input: fx('skinned-column.glb'),
    declaredHeightM: 1.8,
  });
  const io = await getIO();
  const doc = await io.readBinary(bytes);
  const bounds = getBounds(doc.getRoot().listScenes()[0]);
  assert(Math.abs(bounds.max[1] - bounds.min[1] - 1.8) < 1e-3, 'height 1.8 m');
  assert(Math.abs(bounds.min[1]) < 1e-3, 'feet at Y=0');
  // bind validity after skin-aware normalization
  const skin = doc.getRoot().listSkins()[0];
  const ibm = skin.getInverseBindMatrices()!.getArray()! as Float32Array;
  skin.listJoints().forEach((joint, j) => {
    const m = multiply4(joint.getWorldMatrix(), ibm.subarray(j * 16, j * 16 + 16));
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      assert(Math.abs(m[i] - expected) < 1e-3, `IBM invariant broke at joint ${j} elem ${i}`);
    }
  });
});

// --- acceptance: actionable errors -------------------------------------------
Deno.test('acceptance: failures are actionable - no stack traces, names named', async () => {
  const missing = await assertRejects(
    () => importToCanonical({ input: fx('does-not-exist.glb') }),
    ImportError,
  );
  assert(missing.message.includes('does-not-exist.glb'));
  assert(!missing.message.includes('    at '), 'no stack frames in the message');

  const badFormat = await assertRejects(
    () => importToCanonical({ input: fx('cube.objx' as string) }),
    ImportError,
  );
  assert(badFormat.message.includes('.objx'));
  assert(badFormat.message.includes('supported:'));
});

// --- executor: cancelling means cancelled, on the wire and on disk -----------
Deno.test('cancelled import emits ONE terminal event and leaves no artifacts', async () => {
  const outDir = await Deno.makeTempDir({ prefix: 'sb-import-cancel-' });
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 1 });
  const spec = parseWith(
    JobSpecSchema,
    { jobId: 'import-cancel', verb: 'prep', payload: {} },
    'JobSpec',
  );

  // cancel the moment the executor is genuinely running: cancelling while the
  // job is still pending is the QUEUE's path, and would never reach import.ts
  const started = new Promise<void>((resolve) => {
    const stop = bus.listen((e) => {
      if (e.t === 'started') {
        stop();
        resolve();
      }
    });
  });
  const handle = queue.submit(
    spec,
    makeImportExecutor({ input: fx('cube.obj'), declaredHeightM: 0.5, outDir }),
  );
  await started;
  handle.cancel();
  const outcome = await handle.done;

  assertEquals(outcome.kind, 'cancelled');
  assertEquals(outcome.error?.code, 'cancelled');

  // the event vocabulary is a contract (schema/jobs.ts) and the log drawer
  // renders it verbatim: one job, one terminal event
  const events = bus.ring.snapshot();
  const terminal = events.filter((e) => e.t === 'done' || e.t === 'error');
  assertEquals(terminal.map((e) => e.t), ['error'], JSON.stringify(events.map((e) => e.t)));
  assertEquals(events.filter((e) => e.t === 'artifact').length, 0, 'no artifacts were announced');

  // and a cancelled import does not leave a workspace claiming it finished
  for (const name of ['canonical.glb', 'preflight.json']) {
    await assertRejects(
      () => Deno.stat(`${outDir}/${name}`),
      Deno.errors.NotFound,
      undefined,
      `${name} survived a cancelled import`,
    );
  }
});

// --- executor: preflight lands as an artifact event ---------------------------
Deno.test('import executor emits canonical + preflight artifacts through the bus', async () => {
  const outDir = await Deno.makeTempDir({ prefix: 'sb-import-' });
  const bus = new EventBus();
  const queue = new JobQueue({ bus, concurrency: 1 });
  const spec = parseWith(
    JobSpecSchema,
    { jobId: 'import-1', verb: 'prep', payload: {} },
    'JobSpec',
  );
  const outcome = await queue.submit(
    spec,
    makeImportExecutor({ input: fx('cube.obj'), declaredHeightM: 0.5, outDir }),
  ).done;
  assertEquals(outcome.kind, 'done');
  const events = bus.ring.snapshot();
  const artifacts = events.filter((e) => e.t === 'artifact');
  assertEquals(artifacts.map((a) => a.kind), ['canonical-gltf', 'preflight']);
  const preflight = JSON.parse(await Deno.readTextFile(artifacts[1].path));
  assert(Array.isArray(preflight.checks));
  assert(
    preflight.checks.some((c: { id: string }) => c.id === 'normals'),
    'OBJ without normals records the generated-normals fix',
  );
});

// --- the scale must survive being rigged -------------------------------------

/** Y extent and floor of the raw POSITION data, ignoring every node transform. */
function vertexSpanY(doc: Awaited<ReturnType<typeof readDoc>>): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const arr = prim.getAttribute('POSITION')!.getArray() as Float32Array;
      for (let i = 1; i < arr.length; i += 3) {
        min = Math.min(min, arr[i]);
        max = Math.max(max, arr[i]);
      }
    }
  }
  return { min, max };
}

const readDoc = async (bytes: Uint8Array) => await (await getIO()).readBinary(bytes);

Deno.test('an unskinned canonical mesh carries its scale in the VERTICES', async () => {
  // THE regression. The scale used to live only on a `world` node, and glTF
  // says a SKINNED mesh node's transform is ignored because the skin's joints
  // place it. An unskinned canonical mesh is exactly the one about to be
  // rigged, so `rig` silently reverted every generated character to its
  // backend's arbitrary size with its feet below the floor - a 64 px sprite
  // ~20 px tall whose own outline swallowed 81% of it. Nothing caught it
  // because every fixture the renderer sees is unrigged.
  const { bytes } = await importToCanonical({ input: fx('cube.obj'), declaredHeightM: 1.8 });
  const doc = await readDoc(bytes);
  assertEquals(doc.getRoot().listSkins().length, 0, 'fixture is unskinned');

  for (const node of doc.getRoot().listNodes()) {
    if (!node.getMesh()) continue;
    const m = node.getWorldMatrix();
    for (let i = 0; i < 16; i++) {
      assert(
        Math.abs(m[i] - (i % 5 === 0 ? 1 : 0)) < 1e-6,
        `mesh node "${node.getName()}" still carries a transform a skinned reader would drop`,
      );
    }
  }

  const span = vertexSpanY(doc);
  assert(
    Math.abs(span.max - span.min - 1.8) < 1e-3,
    `vertices span 1.8 m, got ${span.max - span.min}`,
  );
  assert(Math.abs(span.min) < 1e-3, `feet at Y=0 in the DATA, got ${span.min}`);
});

Deno.test('the canonical height survives the mesh becoming skinned', async () => {
  // A faithful, GPU-free stand-in for `rig`: what rigging does that broke this
  // is attach a skin, after which the spec says the mesh node's transform no
  // longer places the mesh. If the scale is in the vertices, that is a no-op.
  const { bytes } = await importToCanonical({ input: fx('cube.obj'), declaredHeightM: 1.8 });
  const doc = await readDoc(bytes);
  const before = vertexSpanY(doc);

  const meshNode = doc.getRoot().listNodes().find((n) => n.getMesh() !== null)!;
  const joint = doc.createNode('root_joint');
  doc.getRoot().listScenes()[0].addChild(joint);
  meshNode.setSkin(doc.createSkin('rig').addJoint(joint));

  const after = vertexSpanY(doc);
  assertEquals(after.min, before.min, 'skinning moved the floor');
  assertEquals(after.max, before.max, 'skinning changed the height');
  assert(Math.abs(after.max - after.min - 1.8) < 1e-3, 'still 1.8 m once skinned');
});
