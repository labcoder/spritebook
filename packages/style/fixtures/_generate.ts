/**
 * Style fixture generator (deterministic; run once, the glb is checked in):
 *  - asymmetric.glb   a tiny rigged character: a body box + ONE arm box on +X
 *                     (deliberately asymmetric, per the golden-testing skill, so
 *                     mirroring/outline regressions are visually unmissable). Two
 *                     primitives (body / arm) also exercise the render loader's
 *                     multi-primitive concatenation. Feet on Y=0; 2-joint skin
 *                     (root + shoulder). Boxes use per-face normals so their
 *                     edges are real creases for the outline stage.
 *
 *   node tools/run.mjs packages/style/fixtures/_generate.ts
 */
// full npm specifier: this is a dev-only generator; the style runtime never
// touches glTF (it reads AOV PNGs), so @gltf-transform/core stays out of the
// style package's import map.
import { Document, NodeIO } from '@gltf-transform/core';

const here = new URL('.', import.meta.url);

/** Per-face box: 24 verts (4/face), per-face normals, 36 indices. */
function box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) {
  const faces: Array<{ n: [number, number, number]; verts: Array<[number, number, number]> }> = [
    { n: [0, 0, 1], verts: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], verts: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { n: [1, 0, 0], verts: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { n: [-1, 0, 0], verts: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { n: [0, 1, 0], verts: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { n: [0, -1, 0], verts: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let base = 0;
  for (const f of faces) {
    for (const v of f.verts) {
      positions.push(cx + v[0] * hx, cy + v[1] * hy, cz + v[2] * hz);
      normals.push(...f.n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  return { positions, normals, indices };
}

const doc = new Document();
const buffer = doc.createBuffer();

function primitive(geo: ReturnType<typeof box>, joint: number) {
  const n = geo.positions.length / 3;
  const joints = new Uint8Array(n * 4);
  const weights = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    joints[i * 4] = joint;
    weights[i * 4] = 1;
  }
  return doc.createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(geo.positions)).setBuffer(
        buffer,
      ),
    )
    .setAttribute(
      'NORMAL',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(geo.normals)).setBuffer(
        buffer,
      ),
    )
    .setAttribute(
      'JOINTS_0',
      doc.createAccessor().setType('VEC4').setArray(joints).setBuffer(buffer),
    )
    .setAttribute(
      'WEIGHTS_0',
      doc.createAccessor().setType('VEC4').setArray(weights).setBuffer(buffer),
    )
    .setIndices(
      doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(geo.indices)).setBuffer(
        buffer,
      ),
    );
}

// body: 1.6 m tall, feet on Y=0; arm: one box on +X at shoulder height (asymmetric)
const body = primitive(box(0, 0.8, 0, 0.2, 0.8, 0.15), 0);
const arm = primitive(box(0.4, 1.2, 0, 0.2, 0.08, 0.08), 1);
const mesh = doc.createMesh('character').addPrimitive(body).addPrimitive(arm);

// 2-joint skin: root at origin, shoulder child at (0,1.2,0). IBM = inverse bind world.
const root = doc.createNode('root').setTranslation([0, 0, 0]);
const shoulder = doc.createNode('shoulder').setTranslation([0, 1.2, 0]);
root.addChild(shoulder);
const ibm = new Float32Array([
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1, // root: identity
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  -1.2,
  0,
  1, // shoulder: T(0,-1.2,0)
]);
const skin = doc.createSkin('rig')
  .addJoint(root)
  .addJoint(shoulder)
  .setSkeleton(root)
  .setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));

const charNode = doc.createNode('character').setMesh(mesh).setSkin(skin);
doc.createScene('scene').addChild(root).addChild(charNode);

const out = new URL('asymmetric.glb', here).pathname.replace(/^\/([A-Za-z]:)/, '$1');
await new NodeIO().write(out, doc);
console.log('style fixtures written: asymmetric.glb');
