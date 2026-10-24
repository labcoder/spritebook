/** Frozen CC0 inputs; --run executes bounded inference. Corrected controls retain invalid inputs separately. */
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import {
  loadPackClip,
  loadSkeletonRest,
  retargetClip,
  sampleClip,
  UAL_HUMANOID,
} from '@spritebook/anim';
import { resourcePath, sha256Bytes } from '@spritebook/core';
import { BUNDLED_PACK } from '@spritebook/pack';
import { disposeGpu, runRenderJob } from '@spritebook/render';
import { resolveCamera } from '@spritebook/core';
import { decode } from '@spritebook/image';
import {
  documentToRiggedAsset,
  mat4Multiply,
  skinAll,
  skinMatrices,
} from '../../packages/rig/skin.ts';
import { stripSkins } from '../../packages/rig/strip.ts';
import { runProcess } from '../testing/process.ts';

const root = resolve(process.argv[2] ?? '.render-bench/character-cohort');
const execute = process.argv.includes('--run');
await fs.mkdir(root, { recursive: true });
const io = new NodeIO();
const designs = [
  { id: 'male-separated', body: 'ubc-male', scale: [1, 1, 1] },
  { id: 'female-separated', body: 'ubc-female', scale: [1, 1, 1] },
  { id: 'tall-slim', body: 'ubc-male', scale: [.75, 1.2, .8] },
  { id: 'short-broad', body: 'ubc-male', scale: [1.3, .8, 1.2] },
  { id: 'relaxed-arms', body: 'ubc-female', scale: [1, 1, 1], relaxed: true },
  { id: 'skirt', body: 'ubc-female', scale: [1, 1, 1], skirt: true },
  { id: 'loose-cuffs', body: 'ubc-male', scale: [1, 1, 1], cuffs: true },
  { id: 'asymmetric-mark', body: 'ubc-female', scale: [1, 1, 1], asymmetric: true },
  { id: 'attached-cuffs', body: 'ubc-male', scale: [1, 1, 1], cuffs: true, attached: true },
  {
    id: 'attached-asymmetry',
    body: 'ubc-female',
    scale: [1, 1, 1],
    asymmetric: true,
    attached: true,
  },
  { id: 'framed-broad', body: 'ubc-male', scale: [1.3, .8, 1.2], framed: true },
].filter((design) =>
  process.argv.includes('--framed-broad')
    ? design.framed === true
    : (design.attached === true) === process.argv.includes('--attached-controls') && !design.framed
);
const references: { id: string; image: string; imageSha256: string; recipe: unknown }[] = [];
let frozenText: string | undefined;
try {
  frozenText = await fs.readFile(join(root, 'references.json'), 'utf8');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (frozenText !== undefined) {
  const frozen = JSON.parse(frozenText);
  assert.equal(frozen.references.length, designs.length);
  for (const [index, reference] of frozen.references.entries()) {
    assert.deepEqual(reference.recipe, designs[index], 'Use a fresh directory for changed inputs');
    assert.equal(
      reference.image,
      join(root, 'references', designs[index].id, 'frames/d00_f000_lit.png'),
    );
    assert.equal(
      await sha256Bytes(await fs.readFile(reference.image)),
      reference.imageSha256,
      'Frozen cohort input changed',
    );
    references.push(reference);
  }
}
if (references.length === 0) {
  try {
    for (const design of designs) {
      const dir = join(root, 'references', design.id);
      await fs.mkdir(dir, { recursive: true });
      const source = resourcePath('rig', `bodies/${design.body}/body.glb`);
      const doc = await io.read(source);
      const forearms = new Map(['l', 'r'].map((side) => {
        const point = (name: string) =>
          doc.getRoot().listNodes().find((n) => n.getName() === name)!.getWorldMatrix().slice(
            12,
            15,
          );
        return [side, { elbow: point(`lowerarm_${side}`), wrist: point(`hand_${side}`) }];
      }));
      const asset = documentToRiggedAsset(doc, design.id);
      let positions = asset.positions;
      if (design.relaxed) {
        const clipPath = join(BUNDLED_PACK, 'clips/walk-loop.glb');
        const sourceClip = await loadPackClip(BUNDLED_PACK, 'walk-loop');
        const sourceRest = loadSkeletonRest(await io.read(clipPath));
        const rest = loadSkeletonRest(doc);
        const retargeted = retargetClip(sourceClip, sourceRest, rest, UAL_HUMANOID);
        const sampled = sampleClip(retargeted.clip, rest, { frames: 1, speed: 1, holdLast: true });
        const world = new Float32Array(asset.jointCount * 16);
        for (let j = 0; j < asset.jointCount; j++) {
          const index = sampled.jointNames.indexOf(asset.jointNames[j]);
          assert(index >= 0);
          const local = sampled.data.subarray(index * 16, index * 16 + 16);
          const out = world.subarray(j * 16, j * 16 + 16);
          if (asset.jointParents[j] < 0) out.set(local);
          else {mat4Multiply(
              world.subarray(asset.jointParents[j] * 16, asset.jointParents[j] * 16 + 16),
              local,
              out,
            );}
        }
        positions = skinAll(asset, skinMatrices(world, asset.inverseBind, asset.jointCount));
      }
      let offset = 0;
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          const accessor = primitive.getAttribute('POSITION')!;
          const values = positions.slice(offset * 3, (offset + accessor.getCount()) * 3);
          for (let v = 0; v < values.length; v++) values[v] *= design.scale[v % 3];
          accessor.setArray(values);
          offset += accessor.getCount();
        }
      }
      assert.equal(offset, asset.vertexCount);
      stripSkins(doc);
      for (const animation of doc.getRoot().listAnimations()) animation.dispose();
      const buffer = doc.getRoot().listBuffers()[0];
      const height = Math.max(...positions.filter((_, i) => i % 3 === 1));
      // These explicit separate surfaces are benchmark controls, not inferred garment segmentation.
      const addRingSurface = (
        name: string,
        cx: number,
        y0: number,
        y1: number,
        r0: number,
        r1: number,
        color: [number, number, number, number],
      ) => {
        const p: number[] = [], n: number[] = [], triangles: number[] = [];
        for (let row = 0; row < 5; row++) {
          for (let a = 0; a < 32; a++) {
            const angle = a * Math.PI / 16, r = r0 + (r1 - r0) * row / 4;
            p.push(cx + r * Math.cos(angle), y0 + (y1 - y0) * row / 4, r * .8 * Math.sin(angle));
            n.push(Math.cos(angle), 0, Math.sin(angle));
            if (row < 4) {
              const v = row * 32 + a, next = row * 32 + (a + 1) % 32;
              triangles.push(v, next, v + 32, next, next + 32, v + 32);
            }
          }
        }
        const prim = doc.createPrimitive()
          .setAttribute(
            'POSITION',
            doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer),
          )
          .setAttribute(
            'NORMAL',
            doc.createAccessor().setType('VEC3').setArray(new Float32Array(n)).setBuffer(buffer),
          )
          .setIndices(
            doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(triangles)).setBuffer(
              buffer,
            ),
          )
          .setMaterial(
            doc.createMaterial(name).setBaseColorFactor(color).setRoughnessFactor(.8)
              .setDoubleSided(
                true,
              ),
          );
        const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));
        doc.getRoot().listScenes()[0].addChild(node);
        return node;
      };
      if (design.skirt) {
        addRingSurface(
          'Separate skirt',
          0,
          height * .59,
          height * .32,
          height * .12,
          height * .22,
          [
            .17,
            .32,
            .65,
            1,
          ],
        );
      }
      if (design.attached) {
        for (const side of design.asymmetric ? ['l'] : ['l', 'r']) {
          const { elbow, wrist } = forearms.get(side)!;
          const center = wrist.map((value, index) => .3 * elbow[index] + .7 * value) as [
            number,
            number,
            number,
          ];
          const radius = design.asymmetric ? .05 : .085;
          const cuff = addRingSurface(
            'Reviewed forearm band',
            0,
            -.055,
            .055,
            radius,
            radius,
            design.asymmetric ? [.85, .08, .1, 1] : [.3, .55, .25, 1],
          );
          cuff.setRotation([0, 0, Math.SQRT1_2, Math.SQRT1_2]).setTranslation(center);
          const world = cuff.getWorldMatrix();
          assert(Math.hypot(...center.map((value, index) => value - world[12 + index])) < 1e-6);
          assert(
            Math.abs(world[4]) > .99 && Math.abs(world[5]) < 1e-6,
            'Cuff axis follows the horizontal forearm',
          );
        }
      } else if (design.cuffs) {
        for (const side of [-1, 1]) {
          addRingSurface(
            'Loose cuff',
            side * height * .30,
            height * .60,
            height * .54,
            height * .055,
            height * .07,
            [.3, .55, .25, 1],
          );
        }
      }
      if (design.asymmetric && !design.attached) {
        addRingSurface(
          'Asymmetric red accessory',
          height * .28,
          height * .61,
          height * .55,
          height * .04,
          height * .04,
          [.85, .08, .10, 1],
        );
      }
      const model = join(dir, 'source.glb');
      await fs.writeFile(model, await io.writeBinary(doc));
      for await (
        const event of runRenderJob({
          jobId: 'cohort-reference',
          modelPath: model,
          camera: resolveCamera('standard-30', {
            elevationDeg: 0,
            directions: 2,
            pixelsPerMeter: design.framed ? 170 : 200 / design.scale[1],
            cellPx: { w: 512, h: 512 },
            paddingPx: 12,
          }),
          frames: 1,
          directionSubset: [0],
          pose: 'idle',
          stylePreset: 'clean',
          outDir: dir,
        })
      ) {
        assert.notEqual(event.t, 'error', JSON.stringify(event));
      }
      const image = join(dir, 'frames/d00_f000_lit.png');
      references.push({
        id: design.id,
        image,
        imageSha256: await sha256Bytes(new Uint8Array(await fs.readFile(image))),
        recipe: design,
      });
      console.log('REFERENCE', design.id);
    }
  } finally {
    disposeGpu();
  }
  assert.equal(references.length, designs.length);
  await fs.writeFile(
    join(root, 'references.json'),
    JSON.stringify(
      {
        license: 'CC0-1.0',
        source:
          'Bundled Quaternius Universal Base Characters; controlled procedural variations, not eight independent production designs',
        references,
      },
      null,
      2,
    ),
  );
}

const inputAudit = [];
for (const reference of references) {
  const pixels = decode(await fs.readFile(reference.image));
  const edges = { left: 0, right: 0, top: 0, bottom: 0 };
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      if (!pixels.data[(y * pixels.width + x) * 4 + 3]) continue;
      if (x === 0) edges.left++;
      if (x === pixels.width - 1) edges.right++;
      if (y === 0) edges.top++;
      if (y === pixels.height - 1) edges.bottom++;
    }
  }
  const touchesEdge = Object.values(edges).some((count) => count > 0);
  if (reference.id.startsWith('attached-') || reference.id === 'framed-broad') {
    assert(!touchesEdge, 'A corrected full-body reference must not crop its silhouette');
  }
  inputAudit.push({
    id: reference.id,
    imageSha256: reference.imageSha256,
    edges,
    touchesEdge,
    scope: 'Pixel framing only; ownership and anatomy need visual review',
  });
}
await fs.writeFile(join(root, 'input-audit.json'), JSON.stringify(inputAudit, null, 2));

if (execute) {
  for (const reference of references) {
    for (const model of ['pixal3d', 'trellis2-4b']) {
      const dir = join(root, 'runs', `${reference.id}-${model}`);
      await fs.mkdir(dir, { recursive: true });
      const receipt = join(dir, 'completed.json');
      try {
        const existing = JSON.parse(await fs.readFile(receipt, 'utf8'));
        assert.equal(existing.referenceSha256, reference.imageSha256);
        assert.equal(existing.model, model);
        assert.deepEqual(existing.requestedSeeds, [0, 1000]);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const workspace = join(dir, 'character');
      const args = [
        'gen',
        '--workspace',
        workspace,
        '--character',
        reference.id,
        '--image',
        reference.image,
        '--model',
        model,
        '--seed',
        '0',
        '--candidates',
        '2',
        '--height',
        '1.7',
        '--json',
      ];
      const start = performance.now();
      const result = await runProcess(process.execPath, [
        resolve('packages/cli/dist/entry.js'),
        ...args,
      ], { timeout: 2400000 });
      await fs.writeFile(join(dir, 'generation.ndjson'), result.stdout);
      await fs.writeFile(join(dir, 'generation.stderr'), result.stderr);
      const report = {
        model,
        design: reference.id,
        referenceSha256: reference.imageSha256,
        requestedSeeds: [0, 1000],
        exitCode: result.code,
        seconds: (performance.now() - start) / 1000,
      };
      await fs.writeFile(receipt, JSON.stringify(report, null, 2));
      console.log('GENERATED', JSON.stringify(report));
    }
  }
}
