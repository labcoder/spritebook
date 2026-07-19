/**
 * Hermetic pack-tooling tests (P3-T1): no vendor-assets dependency — sources
 * are synthesized in-test with 2-5 tiny animations each, covering every
 * derivation rule (kebab ids, cross-source collision, loop/category/tags),
 * the split invariants (ONE animation, NO meshes/skins, full skeleton), the
 * resample effect, loadPack/listClips/importPack, and byte determinism.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert@1';
import { Document, NodeIO } from '@gltf-transform/core';
import { canonicalJson } from '@spritebook/schema';
import {
  buildPack,
  clipCategory,
  clipTags,
  importPack,
  listClips,
  loadPack,
  toClipId,
} from './pack.ts';
import { PACK_CLIP_DIR, PACK_MANIFEST } from './contracts.ts';

const SQ = Math.SQRT1_2;
const DENSE_KEYS = 31;

interface AnimSpec {
  name: string;
  /** f32-exact durations keep duration asserts exact */
  duration: number;
  /** add a dense linear-redundant translation track (resample collapses it) */
  dense?: boolean;
}

/** A tiny rigged source: 3-joint chain + skinned triangle + given animations. */
async function makeSourceGlb(
  anims: AnimSpec[],
  jointNames: string[] = ['root', 'pelvis', 'thigh_l'],
): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const nodes = jointNames.map((n, i) => doc.createNode(n).setTranslation([0, i * 0.5, 0]));
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].addChild(nodes[i]);

  const positions = doc.createAccessor().setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const mesh = doc.createMesh('body').addPrimitive(
    doc.createPrimitive().setAttribute('POSITION', positions),
  );
  const ibm = new Float32Array(jointNames.length * 16);
  for (let i = 0; i < jointNames.length; i++) {
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], i * 16);
  }
  const skin = doc.createSkin('rig').setSkeleton(nodes[0]).setInverseBindMatrices(
    doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer),
  );
  for (const n of nodes) skin.addJoint(n);
  const meshNode = doc.createNode('body').setMesh(mesh).setSkin(skin);
  doc.createScene('scene').addChild(nodes[0]).addChild(meshNode);

  for (const spec of anims) {
    const anim = doc.createAnimation(spec.name);
    const rotSampler = doc.createAnimationSampler().setInterpolation('LINEAR')
      .setInput(
        doc.createAccessor().setType('SCALAR')
          .setArray(new Float32Array([0, spec.duration])).setBuffer(buffer),
      )
      .setOutput(
        doc.createAccessor().setType('VEC4')
          .setArray(new Float32Array([0, 0, 0, 1, SQ, 0, 0, SQ])).setBuffer(buffer),
      );
    anim.addSampler(rotSampler).addChannel(
      doc.createAnimationChannel().setTargetNode(nodes[1]).setTargetPath('rotation')
        .setSampler(rotSampler),
    );
    if (spec.dense) {
      const times = new Float32Array(DENSE_KEYS);
      const values = new Float32Array(DENSE_KEYS * 3);
      for (let i = 0; i < DENSE_KEYS; i++) {
        const u = i / (DENSE_KEYS - 1);
        times[i] = u * spec.duration;
        values[i * 3] = u; // exactly linear: interior keys are lerp-redundant
      }
      const denseSampler = doc.createAnimationSampler().setInterpolation('LINEAR')
        .setInput(doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer))
        .setOutput(doc.createAccessor().setType('VEC3').setArray(values).setBuffer(buffer));
      anim.addSampler(denseSampler).addChannel(
        doc.createAnimationChannel().setTargetNode(nodes[0]).setTargetPath('translation')
          .setSampler(denseSampler),
      );
    }
  }
  return await new NodeIO().writeBinary(doc);
}

const SRC_A: AnimSpec[] = [
  { name: 'Walk_Loop', duration: 1, dense: true },
  { name: 'Punch_Jab', duration: 0.5 },
  { name: 'A_TPose', duration: 2.5 },
  { name: 'PickUp_Table', duration: 0.75 },
  { name: 'Idle_Loop', duration: 2 },
];
const SRC_B: AnimSpec[] = [
  { name: 'A_TPose', duration: 2.5 }, // collides with SRC_A across sources
  { name: 'Death01', duration: 1.5 },
];

const META = {
  id: 'test-pack',
  name: 'Test pack',
  version: '1',
  license: 'CC0-1.0',
  redistributable: true,
  source: 'synthetic fixtures (pack_test.ts)',
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = (await Deno.makeTempDir({ prefix: 'spritebook-pack-test-' })).replaceAll('\\', '/');
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Write both synthetic sources and build the pack into `<dir>/pack`. */
async function buildFixture(dir: string) {
  const srcGlbs = [`${dir}/srcA.glb`, `${dir}/srcB.glb`];
  await Deno.writeFile(srcGlbs[0], await makeSourceGlb(SRC_A));
  await Deno.writeFile(srcGlbs[1], await makeSourceGlb(SRC_B));
  const outDir = `${dir}/pack`;
  const pack = await buildPack({ srcGlbs, outDir, meta: META });
  return { srcGlbs, outDir, pack };
}

function assertSameBytes(a: Uint8Array, b: Uint8Array, what: string) {
  assert(a.length === b.length && a.every((v, i) => v === b[i]), `${what}: bytes differ`);
}

Deno.test('derivation helpers: kebab ids, prefix categories, tags', () => {
  assertEquals(toClipId('Walk_Loop'), 'walk-loop');
  assertEquals(toClipId('A_TPose'), 'a-tpose'); // uppercase runs stay one word
  assertEquals(toClipId('PickUp_Table'), 'pick-up-table');
  assertEquals(toClipId('Death01'), 'death01');
  assertEquals(toClipId('ClimbUp_1m'), 'climb-up-1m');
  assertEquals(toClipId('Idle_TalkingPhone_Loop'), 'idle-talking-phone-loop');

  assertEquals(clipCategory('walk-loop'), 'locomotion');
  assertEquals(clipCategory('crouch-idle-loop'), 'locomotion'); // prefix beats inner word
  assertEquals(clipCategory('idle-loop'), 'idle');
  assertEquals(clipCategory('death01'), 'combat'); // prefix, not whole-word, match
  assertEquals(clipCategory('a-tpose'), 'pose');
  assertEquals(clipCategory('sitting-idle-loop'), 'other');

  assertEquals(clipTags('walk-loop', 'locomotion'), ['walk', 'loop', 'locomotion']);
  assertEquals(clipTags('idle-loop', 'idle'), ['idle', 'loop']); // category deduped
});

Deno.test('buildPack splits every animation into a clip with derived metadata', async () => {
  await withTempDir(async (dir) => {
    const { outDir, pack } = await buildFixture(dir);

    assertEquals(pack.clips.map((c) => c.id), [
      'a-tpose',
      'a-tpose-2',
      'death01',
      'idle-loop',
      'pick-up-table',
      'punch-jab',
      'walk-loop',
    ]);
    assertEquals(pack.id, 'test-pack');
    assertEquals(pack.skeleton, 'ual-humanoid');

    const byId = new Map(pack.clips.map((c) => [c.id, c]));
    assertEquals(byId.get('walk-loop'), {
      id: 'walk-loop',
      name: 'Walk_Loop',
      category: 'locomotion',
      tags: ['walk', 'loop', 'locomotion'],
      durationS: 1,
      loop: true,
    });
    assertEquals(byId.get('a-tpose-2')!.name, 'A_TPose'); // collision keeps the source name
    assertEquals(byId.get('a-tpose-2')!.category, 'pose');
    assertEquals(byId.get('a-tpose-2')!.tags, ['a', 'tpose', 'pose']);
    assertEquals(byId.get('death01')!.category, 'combat');
    assertEquals(byId.get('death01')!.durationS, 1.5);
    assertEquals(byId.get('pick-up-table')!.category, 'other');
    assertEquals(byId.get('pick-up-table')!.tags, ['pick', 'up', 'table', 'other']);
    assertEquals(byId.get('idle-loop')!.loop, true);
    assertEquals(byId.get('punch-jab')!.loop, false);
    assertEquals(byId.get('punch-jab')!.durationS, 0.5);

    for (const clip of pack.clips) {
      const stat = await Deno.stat(`${outDir}/${PACK_CLIP_DIR}/${clip.id}.glb`);
      assert(stat.isFile && stat.size > 0, `${clip.id}.glb missing or empty`);
    }
  });
});

Deno.test('built clip glbs: exactly one animation, no meshes/skins, full skeleton', async () => {
  await withTempDir(async (dir) => {
    const { outDir, pack } = await buildFixture(dir);
    const io = new NodeIO();
    for (const clip of pack.clips) {
      const doc = await io.readBinary(
        await Deno.readFile(`${outDir}/${PACK_CLIP_DIR}/${clip.id}.glb`),
      );
      const root = doc.getRoot();
      assertEquals(root.listAnimations().length, 1, `${clip.id}: not exactly one animation`);
      assertEquals(root.listAnimations()[0].getName(), clip.name);
      assertEquals(root.listMeshes().length, 0, `${clip.id}: meshes not stripped`);
      assertEquals(root.listSkins().length, 0, `${clip.id}: skins not stripped`);
      assertEquals(
        root.listNodes().map((n) => n.getName()).sort(),
        ['pelvis', 'root', 'thigh_l'],
        `${clip.id}: skeleton nodes changed`,
      );
    }
  });
});

Deno.test('resample strips dense-baked redundant keys', async () => {
  await withTempDir(async (dir) => {
    const { outDir } = await buildFixture(dir);
    const doc = await new NodeIO().readBinary(
      await Deno.readFile(`${outDir}/${PACK_CLIP_DIR}/walk-loop.glb`),
    );
    const anim = doc.getRoot().listAnimations()[0];
    const dense = anim.listChannels().find((c) => c.getTargetPath() === 'translation');
    assert(dense, 'translation channel missing');
    assertEquals(dense.getSampler()!.getInput()!.getCount(), 2, `expected ${DENSE_KEYS} -> 2 keys`);
  });
});

Deno.test('pack.json is canonical JSON', async () => {
  await withTempDir(async (dir) => {
    const { outDir } = await buildFixture(dir);
    const text = await Deno.readTextFile(`${outDir}/${PACK_MANIFEST}`);
    assertEquals(text, canonicalJson(JSON.parse(text)));
  });
});

Deno.test('loadPack round-trips and reports missing clip files', async () => {
  await withTempDir(async (dir) => {
    const { outDir, pack } = await buildFixture(dir);
    assertEquals(await loadPack(outDir), pack);

    await Deno.remove(`${outDir}/${PACK_CLIP_DIR}/walk-loop.glb`);
    const err = await assertRejects(() => loadPack(outDir), Error);
    assertStringIncludes(err.message, 'walk-loop.glb');
  });
});

Deno.test('listClips filters by tag and category (AND semantics)', async () => {
  await withTempDir(async (dir) => {
    const { pack } = await buildFixture(dir);
    const ids = (r: { id: string }[]) => r.map((c) => c.id);

    assertEquals(listClips(pack).length, 7);
    assertEquals(ids(listClips(pack, { tag: 'walk' })), ['walk-loop']);
    assertEquals(ids(listClips(pack, { category: 'combat' })), ['death01', 'punch-jab']);
    assertEquals(ids(listClips(pack, { tag: 'loop', category: 'idle' })), ['idle-loop']);
    assertEquals(listClips(pack, { tag: 'no-such-tag' }), []);
  });
});

Deno.test('importPack installs a valid pack into the packs root', async () => {
  await withTempDir(async (dir) => {
    const { outDir, pack } = await buildFixture(dir);
    const packsRoot = `${dir}/packs`;
    const imported = await importPack(outDir, packsRoot);
    assertEquals(imported, pack);

    const installed = await loadPack(`${packsRoot}/${pack.id}`);
    assertEquals(installed, pack);
    for (const clip of pack.clips) {
      assertSameBytes(
        await Deno.readFile(`${outDir}/${PACK_CLIP_DIR}/${clip.id}.glb`),
        await Deno.readFile(`${packsRoot}/${pack.id}/${PACK_CLIP_DIR}/${clip.id}.glb`),
        `${clip.id}.glb`,
      );
    }
  });
});

Deno.test('importPack rejects a manifest that does not declare redistributable', async () => {
  await withTempDir(async (dir) => {
    const { outDir } = await buildFixture(dir);
    const manifest = JSON.parse(await Deno.readTextFile(`${outDir}/${PACK_MANIFEST}`));
    delete manifest.redistributable;
    await Deno.writeTextFile(`${outDir}/${PACK_MANIFEST}`, canonicalJson(manifest));

    const err = await assertRejects(() => importPack(outDir, `${dir}/packs`), Error);
    assertStringIncludes(err.message, 'redistributable');
    assertStringIncludes(err.message, 'D-013');
  });
});

Deno.test('importPack refuses to overwrite an installed pack', async () => {
  await withTempDir(async (dir) => {
    const { outDir } = await buildFixture(dir);
    const packsRoot = `${dir}/packs`;
    await importPack(outDir, packsRoot);
    const err = await assertRejects(() => importPack(outDir, packsRoot), Error);
    assertStringIncludes(err.message, 'already installed');
  });
});

Deno.test('building twice produces byte-identical pack.json and clip glbs', async () => {
  await withTempDir(async (dir) => {
    const { srcGlbs, outDir, pack } = await buildFixture(dir);
    const outDir2 = `${dir}/pack2`;
    const pack2 = await buildPack({ srcGlbs, outDir: outDir2, meta: META });

    assertEquals(pack2, pack);
    assertSameBytes(
      await Deno.readFile(`${outDir}/${PACK_MANIFEST}`),
      await Deno.readFile(`${outDir2}/${PACK_MANIFEST}`),
      PACK_MANIFEST,
    );
    for (const clip of pack.clips) {
      assertSameBytes(
        await Deno.readFile(`${outDir}/${PACK_CLIP_DIR}/${clip.id}.glb`),
        await Deno.readFile(`${outDir2}/${PACK_CLIP_DIR}/${clip.id}.glb`),
        `${clip.id}.glb`,
      );
    }
  });
});

Deno.test('buildPack rejects mismatched skeletons and unreadable sources', async () => {
  await withTempDir(async (dir) => {
    const srcA = `${dir}/srcA.glb`;
    const srcC = `${dir}/srcC.glb`;
    await Deno.writeFile(srcA, await makeSourceGlb(SRC_A));
    await Deno.writeFile(
      srcC,
      await makeSourceGlb([{ name: 'Wave', duration: 1 }], ['root', 'spine']),
    );

    const err = await assertRejects(
      () => buildPack({ srcGlbs: [srcA, srcC], outDir: `${dir}/pack`, meta: META }),
      Error,
    );
    assertStringIncludes(err.message, 'different skeleton');

    const missing = await assertRejects(
      () => buildPack({ srcGlbs: [`${dir}/nope.glb`], outDir: `${dir}/pack`, meta: META }),
      Error,
    );
    assertStringIncludes(missing.message, 'cannot read source glb');
  });
});
