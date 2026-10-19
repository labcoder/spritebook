/**
 * runIdentityJob drives the identity layer over a REAL picked workspace, so
 * the setup is the P3-T2 acceptance path on the weightless fixture backend
 * (fixture-gen through the real sidecar — gated on uv + the checkout, no GPU
 * anywhere). identity_test.ts owns the surgery's correctness; these tests own
 * the JOB: refusals before mutation, stage order, the re-pinned hash, and the
 * journaled identity records.
 *
 * The gen/pick helpers are copied from acceptance_test.ts rather than
 * imported — test files do not import test files — and the minimal skinned
 * body is adapted from identity_test.ts's fixture for the same reason.
 */
import { assert, assertEquals, assertGreater } from 'jsr:@std/assert@1';
import { encode as encodePng } from 'fast-png';
import { Document, NodeIO } from '@gltf-transform/core';
import type { CanonicalBody, JobEvent, RigState } from '@spritebook/schema';
import {
  CHARACTER_SCHEMA_VERSION,
  CharacterManifestSchema,
  JobEventSchema,
  parseWith,
} from '@spritebook/schema';
import { setRigState, workspacePaths } from '@spritebook/core';
import { loadCatalog, runInstallJob } from '@spritebook/registry';
import { runGenJob, runIdentityJob, runPickJob } from './mod.ts';

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
      data[at] = (x * 2) % 256;
      data[at + 1] = (y * 3) % 256;
      data[at + 2] = 180;
      data[at + 3] = 255;
    }
  }
  return data;
}

/** Drain the stream, proving every event honours the NDJSON contract. */
async function collect(it: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const e of it) out.push(parseWith(JobEventSchema, e, 'JobEvent'));
  return out;
}

function artifact(events: JobEvent[], kind: string): string {
  const e = events.find((x) => x.t === 'artifact' && x.kind === kind);
  assert(e, `expected a ${kind} artifact; got ${JSON.stringify(events.at(-1))}`);
  return (e as { path: string }).path;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function solid(size: number, rgba: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set(rgba, i * 4);
  return data;
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
  work: string;
  workspace: string;
  image: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: 'sb-identity-models-' });
  const work = await Deno.makeTempDir({ prefix: 'sb-identity-' });
  await installFixtureBackend(root);
  const image = `${work}/cutout.png`;
  await Deno.writeFile(image, encodePng({ width: 128, height: 192, data: cutout() }));
  return {
    root,
    work,
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

/** A workspace with a real generated result, picked — identity's precondition. */
async function pickedWorkspace(reproject: boolean): Promise<Fixture> {
  const f = await setup();
  const gen = await collect(runGenJob(genOpts(f)));
  assert(!gen.find((e) => e.t === 'error'), `gen failed: ${JSON.stringify(gen.at(-1))}`);
  const picked = await collect(
    runPickJob({ jobId: 'itest-pick', workspace: f.workspace, resultId: 'r1', reproject }),
  );
  assert(!picked.find((e) => e.t === 'error'), `pick failed: ${JSON.stringify(picked.at(-1))}`);
  return f;
}

// ---------------------------------------------------------------------------
// A minimal SKINNED canonical mesh (adapted from identity_test.ts): three
// quads, each 100% weighted to its own joint and UV-mapped onto its region's
// rect on a 64px grey texture. fixture-gen meshes are unskinned, and masks
// and attachments address a skeleton, so the full-stack test stages this in.
// ---------------------------------------------------------------------------

const TEX = 64;

const MINI_BODY: CanonicalBody = {
  schemaVersion: CHARACTER_SCHEMA_VERSION,
  id: 'mini-body',
  displayName: 'Mini body',
  license: 'CC0-1.0',
  source: 'identityjob_test.ts',
  skeleton: 'ual-humanoid',
  jointCount: 3,
  vertexCount: 12,
  heightM: 1,
  regions: [
    {
      id: 'forearm-l',
      joints: ['forearm-l'],
      uvRect: { x: 0, y: 0, w: 0.25, h: 0.25 },
      side: 'left',
    },
    {
      id: 'forearm-r',
      joints: ['forearm-r'],
      uvRect: { x: 0.5, y: 0, w: 0.25, h: 0.25 },
      side: 'right',
    },
    {
      id: 'chest',
      joints: ['root'],
      uvRect: { x: 0.25, y: 0.5, w: 0.5, h: 0.5 },
      side: 'center',
    },
  ],
};

async function miniBodyGlb(path: string): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const quads = [
    { joint: 0, region: 'chest', x: 0 },
    { joint: 1, region: 'forearm-l', x: 2 },
    { joint: 2, region: 'forearm-r', x: -2 },
  ];
  quads.forEach((q, i) => {
    const r = MINI_BODY.regions.find((reg) => reg.id === q.region)!.uvRect;
    const corners: Array<[number, number]> = [[0, 1], [1, 1], [0, 0], [1, 0]];
    for (const [cx, cy] of corners) {
      positions.push(q.x + cx, cy, 0);
      normals.push(0, 0, 1);
      uvs.push(r.x + cx * r.w, r.y + (1 - cy) * r.h);
      joints.push(q.joint, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
    const base = i * 4;
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  });

  const acc = (
    name: string,
    type: 'VEC3' | 'VEC2' | 'VEC4' | 'MAT4' | 'SCALAR',
    array: ArrayLike<number>,
  ) => doc.createAccessor(name).setType(type).setArray(array as never).setBuffer(buffer);

  const base = new Uint8Array(TEX * TEX * 4).fill(128);
  for (let i = 3; i < base.length; i += 4) base[i] = 255;
  const material = doc.createMaterial('body').setBaseColorTexture(
    doc.createTexture('base')
      .setImage(encodePng({ width: TEX, height: TEX, data: base }))
      .setMimeType('image/png'),
  );

  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('P', 'VEC3', new Float32Array(positions)))
    .setAttribute('NORMAL', acc('N', 'VEC3', new Float32Array(normals)))
    .setAttribute('TEXCOORD_0', acc('UV', 'VEC2', new Float32Array(uvs)))
    .setAttribute('JOINTS_0', acc('J', 'VEC4', new Uint8Array(joints)))
    .setAttribute('WEIGHTS_0', acc('W', 'VEC4', new Float32Array(weights)))
    .setIndices(acc('I', 'SCALAR', new Uint16Array(indices)))
    .setMaterial(material);
  const node = doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(prim));

  const jointNodes = ['root', 'forearm-l', 'forearm-r'].map((n) => doc.createNode(n));
  const ibm = new Float32Array(jointNodes.length * 16);
  for (let j = 0; j < jointNodes.length; j++) {
    for (let e = 0; e < 4; e++) ibm[j * 16 + e * 5] = 1; // identity
  }
  const skin = doc.createSkin('rig')
    .setSkeleton(jointNodes[0])
    .setInverseBindMatrices(acc('IBM', 'MAT4', ibm));
  for (const j of jointNodes) skin.addJoint(j);
  jointNodes[0].addChild(jointNodes[1]).addChild(jointNodes[2]);
  node.setSkin(skin);
  doc.createScene('s').addChild(node).addChild(jointNodes[0]);

  await Deno.writeFile(path, await new NodeIO().writeBinary(doc));
}

/** A rigid quad prop, optionally under a lifted node (world transform bakes in). */
async function propGlb(path: string, lift = 0): Promise<void> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC3' | 'SCALAR', array: ArrayLike<number>) =>
    doc.createAccessor().setType(type).setArray(array as never).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 1, 3, 2])));
  const node = doc.createNode('prop')
    .setMesh(doc.createMesh('prop').addPrimitive(prim))
    .setTranslation([0, lift, 0]);
  doc.createScene('s').addChild(node);
  await Deno.writeFile(path, await new NodeIO().writeBinary(doc));
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

Deno.test('identity: a decal-only run changes the canonical bytes and the manifest follows', async () => {
  if (!(await sidecarAvailable())) {
    console.log('skip: uv or sidecar/ not available');
    return;
  }
  // picked WITH reprojection — the order Track A documents (pick, then
  // reproject, then identity). RGB backend textures are no longer the reason:
  // compositeDecals normalizes any channel layout at its decode boundary, and
  // identity_test.ts covers the 3-channel case directly. This stays the
  // reprojected path because it is the documented one.
  const f = await pickedWorkspace(true);
  try {
    const paths = workspacePaths(f.workspace);
    const before = await Deno.readFile(paths.canonicalModel);
    const png = `${f.work}/tattoo.png`;
    await Deno.writeFile(
      png,
      encodePng({ width: 8, height: 8, data: solid(8, [255, 0, 255, 255]) }),
    );

    const events = await collect(runIdentityJob({
      jobId: 'itest-identity-decal',
      workspace: f.workspace,
      decals: [{
        id: 'tattoo',
        pngPath: png,
        uvRect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        z: 0,
        mirrored: false,
      }],
    }));
    assertEquals(events.filter((e) => e.t === 'error'), [], JSON.stringify(events.at(-1)));
    assertEquals(events.at(-1)?.t, 'done');

    const canonicalPath = artifact(events, 'canonical-model');
    assertEquals(canonicalPath, paths.canonicalModel, 'identity edits THE canonical mesh');
    const after = await Deno.readFile(canonicalPath);
    assert(
      before.length !== after.length || !before.every((v, i) => v === after[i]),
      'the decal changed the canonical bytes',
    );

    const report = JSON.parse(await Deno.readTextFile(artifact(events, 'identity-decals-report')));
    assertGreater(report.changedTexels, 0, 'the decal painted real texels');
    assertEquals(report.missed, [], 'nothing silently missed');

    // the manifest pins the bytes that are NOW on disk, and records the layer
    const manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await Deno.readTextFile(artifact(events, 'character-manifest'))),
      'CharacterManifest',
    );
    assertEquals(manifest.canonicalMesh?.gltfSha256, await sha256Hex(after));
    assertEquals(manifest.detailLayers?.length, 1, 'the decal is journaled as a detail layer');
    assertEquals(manifest.detailLayers?.[0].id, 'tattoo');
    assertEquals(manifest.detailLayers?.[0].uvDecalPng, png);
    assertEquals(
      manifest.detailLayers?.[0].region,
      undefined,
      'placed by uvRect, so no region is recorded',
    );

    // ONE patch for the whole pass: the identity records and the canonical
    // re-pin land together, so a single undo cannot leave a manifest that
    // claims no identity while pinning the tattooed bytes
    const lines = (await Deno.readTextFile(paths.journal)).split('\n').filter((l) => l);
    const patch = JSON.parse(lines.at(-1)!);
    const touched = (patch.op as { path: string }[]).map((o) => o.path).sort();
    assertEquals(touched, ['/canonicalMesh', '/detailLayers'], 'both facts, one patch');
    assertEquals(patch.inverse.length, 2, 'and one undo takes both back');
  } finally {
    await f.cleanup();
  }
});

Deno.test('identity: refused when nothing is picked, naming `spritebook pick`', async () => {
  if (!(await sidecarAvailable())) return;
  const f = await setup();
  try {
    const gen = await collect(runGenJob(genOpts(f)));
    assert(!gen.find((e) => e.t === 'error'), JSON.stringify(gen.at(-1)));
    const png = `${f.work}/tattoo.png`;
    await Deno.writeFile(
      png,
      encodePng({ width: 4, height: 4, data: solid(4, [255, 0, 0, 255]) }),
    );

    const events = await collect(runIdentityJob({
      jobId: 'itest-identity-unpicked',
      workspace: f.workspace,
      decals: [{
        id: 'tattoo',
        pngPath: png,
        uvRect: { x: 0, y: 0, w: 1, h: 1 },
        z: 0,
        mirrored: false,
      }],
    }));
    const err = events.at(-1);
    assert(err?.t === 'error', `expected a terminal error, got ${JSON.stringify(err)}`);
    if (err.t === 'error') {
      assertEquals(err.code, 'identity-not-picked');
      assert(err.message.includes('spritebook pick'), `names the fixing verb: ${err.message}`);
    }
    // and nothing was mutated: no canonical model appeared
    let exists = true;
    try {
      await Deno.stat(workspacePaths(f.workspace).canonicalModel);
    } catch {
      exists = false;
    }
    assertEquals(exists, false, 'no canonical model was invented');
  } finally {
    await f.cleanup();
  }
});

Deno.test('identity: refused when no operation is given', async () => {
  // no sidecar needed: the refusal happens before the workspace is even read
  const dir = await Deno.makeTempDir({ prefix: 'sb-identity-noop-' });
  try {
    const events = await collect(runIdentityJob({
      jobId: 'itest-identity-noop',
      workspace: dir,
      decals: [], // explicitly empty counts as "nothing to apply"
    }));
    const err = events.at(-1);
    assert(err?.t === 'error', `expected a terminal error, got ${JSON.stringify(err)}`);
    if (err.t === 'error') {
      assertEquals(err.code, 'identity-no-op');
      assert(err.message.includes('decal'), `says what WOULD count: ${err.message}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('identity: bone mask -> attachments -> decals, in that order, all journaled', async () => {
  if (!(await sidecarAvailable())) return;
  // a plain pick suffices: the canonical mesh is replaced by the mini body
  // below, so the fixture texture never reaches the decal compositor
  const f = await pickedWorkspace(false);
  try {
    const paths = workspacePaths(f.workspace);
    // Rigged fixture bytes must be published with their real hash, like a rig job.
    const stagedBody = `${f.work}/body.glb`;
    await miniBodyGlb(stagedBody);
    const bodyJson = `${f.work}/body.json`;
    await Deno.writeTextFile(bodyJson, JSON.stringify(MINI_BODY));
    const rig: RigState = {
      track: 'B',
      backend: { modelId: 'unirig', version: 'test' },
      skeletonProfile: 'generic',
      jointCount: 3,
      jointEdits: [],
      orientationFixes: [],
      sockets: [{ id: 'hand-r', bone: 'forearm-r', localOffset: [0, 0.1, 0] }],
      accepted: false,
    };
    await setRigState(f.workspace, rig, {
      canonicalSource: stagedBody,
      canonicalMesh: { gltfSha256: await sha256Hex(await Deno.readFile(stagedBody)) },
    });

    const prop = `${f.work}/prop.glb`;
    const replacement = `${f.work}/replacement.glb`;
    const png = `${f.work}/emblem.png`;
    await propGlb(prop);
    await propGlb(replacement, 5);
    await Deno.writeFile(
      png,
      encodePng({ width: 8, height: 8, data: solid(8, [0, 255, 0, 255]) }),
    );

    const events = await collect(runIdentityJob({
      jobId: 'itest-identity-all',
      workspace: f.workspace,
      bodyManifestPath: bodyJson,
      boneMask: { 'forearm-l': replacement },
      attachments: [{ id: 'sword', socketId: 'hand-r', meshPath: prop }],
      decals: [{ id: 'emblem', pngPath: png, region: 'chest', z: 0, mirrored: false }],
    }));
    assertEquals(events.filter((e) => e.t === 'error'), [], JSON.stringify(events.at(-1)));
    assertEquals(events.at(-1)?.t, 'done');

    // THE ORDER: replace geometry, then hang meshes, then paint the surface —
    // observable in the stream, stage by stage
    assertEquals(
      events.filter((e) => e.t === 'progress').map((e) => (e as { step: string }).step),
      ['bone-mask', 'attachments', 'decals', 'record'],
    );
    assertEquals(
      events.filter((e) => e.t === 'artifact').map((e) => (e as { kind: string }).kind),
      [
        'identity-bone-mask-report',
        'identity-attachments-report',
        'identity-decals-report',
        'canonical-model',
        'character-manifest',
      ],
    );

    // every stage really landed, on ONE file
    const doc = await new NodeIO().readBinary(await Deno.readFile(paths.canonicalModel));
    const joint = doc.getRoot().listNodes().find((n) => n.getName() === 'forearm-r');
    assert(
      joint?.listChildren().some((c) => c.getName() === 'attach-sword'),
      'the prop hangs off its socket joint',
    );
    const positions: number[] = [];
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        positions.push(...Array.from(prim.getAttribute('POSITION')?.getArray() ?? []));
      }
    }
    assert(positions.includes(5), 'the bone-mask replacement is in the file');
    assert(
      !positions.some((v, i) => i % 3 === 0 && v === 2),
      'the masked forearm-l quad is gone',
    );

    // and the whole pass is in the manifest, hash re-pinned to the final bytes
    const manifest = parseWith(
      CharacterManifestSchema,
      JSON.parse(await Deno.readTextFile(paths.manifest)),
      'CharacterManifest',
    );
    assertEquals(
      manifest.canonicalMesh?.gltfSha256,
      await sha256Hex(await Deno.readFile(paths.canonicalModel)),
      'the manifest follows the bytes ACTUALLY on disk',
    );
    assertEquals(manifest.rig?.boneMask, { 'forearm-l': replacement });
    assertEquals(manifest.attachments, [{
      id: 'sword',
      socketId: 'hand-r',
      meshSha256: await sha256Hex(await Deno.readFile(prop)),
    }]);
    assertEquals(manifest.detailLayers, [{ id: 'emblem', uvDecalPng: png, region: 'chest' }]);
  } finally {
    await f.cleanup();
  }
});
