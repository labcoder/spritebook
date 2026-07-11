// P0-T2: generate the test asset — a small skinned glTF, procedurally, so the
// spike is hermetic (no downloaded asset, no license question, deterministic bytes).
// A tapered cylinder "column" with a 4-joint chain along +Y; smooth weights
// between adjacent joints. Written as GLB via glTF-Transform (the importer-border
// library this repo standardizes on, docs/dependencies.md).

import { Document, WebIO } from 'npm:@gltf-transform/core@4.2.1';

const JOINT_COUNT = 4;
const HEIGHT = 2.0;
const SEG_H = HEIGHT / (JOINT_COUNT - 1);
const RINGS = 25; // vertical resolution
const SEGMENTS = 16; // radial resolution
const RADIUS = 0.22;

const vertexCount = RINGS * SEGMENTS;
const positions = new Float32Array(vertexCount * 3);
const normals = new Float32Array(vertexCount * 3);
const jointIdx = new Uint8Array(vertexCount * 4);
const weights = new Float32Array(vertexCount * 4);

for (let r = 0; r < RINGS; r++) {
  const y = (r / (RINGS - 1)) * HEIGHT;
  // slight taper toward the top so lit/depth output has visible structure
  const rad = RADIUS * (1.0 - 0.35 * (y / HEIGHT));
  const t = y / SEG_H;
  const i0 = Math.min(Math.floor(t), JOINT_COUNT - 2);
  const frac = t - i0;
  for (let s = 0; s < SEGMENTS; s++) {
    const v = r * SEGMENTS + s;
    const a = (s / SEGMENTS) * Math.PI * 2;
    const cx = Math.cos(a), sz = Math.sin(a);
    positions[v * 3] = cx * rad;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = sz * rad;
    normals[v * 3] = cx;
    normals[v * 3 + 1] = 0;
    normals[v * 3 + 2] = sz;
    jointIdx[v * 4] = i0;
    jointIdx[v * 4 + 1] = i0 + 1;
    weights[v * 4] = 1 - frac;
    weights[v * 4 + 1] = frac;
  }
}

const indices = new Uint16Array((RINGS - 1) * SEGMENTS * 6);
let k = 0;
for (let r = 0; r < RINGS - 1; r++) {
  for (let s = 0; s < SEGMENTS; s++) {
    const s1 = (s + 1) % SEGMENTS;
    const v00 = r * SEGMENTS + s, v01 = r * SEGMENTS + s1;
    const v10 = (r + 1) * SEGMENTS + s, v11 = (r + 1) * SEGMENTS + s1;
    indices[k++] = v00;
    indices[k++] = v10;
    indices[k++] = v01;
    indices[k++] = v01;
    indices[k++] = v10;
    indices[k++] = v11;
  }
}

// inverse bind matrices: joint i sits at world (0, i*SEG_H, 0) in bind pose
const ibm = new Float32Array(JOINT_COUNT * 16);
for (let i = 0; i < JOINT_COUNT; i++) {
  ibm[i * 16] = ibm[i * 16 + 5] = ibm[i * 16 + 10] = ibm[i * 16 + 15] = 1;
  ibm[i * 16 + 13] = -i * SEG_H;
}

const doc = new Document();
const buffer = doc.createBuffer('bin');
const scene = doc.createScene('scene');

const acc = (name: string, type: 'VEC3' | 'VEC4' | 'SCALAR' | 'MAT4', array: Float32Array | Uint8Array | Uint16Array) =>
  doc.createAccessor(name).setType(type).setArray(array).setBuffer(buffer);

const joints = [];
for (let i = 0; i < JOINT_COUNT; i++) {
  const j = doc.createNode(`joint${i}`).setTranslation([0, i === 0 ? 0 : SEG_H, 0]);
  if (i === 0) scene.addChild(j);
  else joints[i - 1].addChild(j);
  joints.push(j);
}

const skin = doc.createSkin('skin')
  .setSkeleton(joints[0])
  .setInverseBindMatrices(acc('ibm', 'MAT4', ibm));
for (const j of joints) skin.addJoint(j);

const prim = doc.createPrimitive()
  .setAttribute('POSITION', acc('pos', 'VEC3', positions))
  .setAttribute('NORMAL', acc('nrm', 'VEC3', normals))
  .setAttribute('JOINTS_0', acc('joints', 'VEC4', jointIdx))
  .setAttribute('WEIGHTS_0', acc('weights', 'VEC4', weights))
  .setIndices(acc('idx', 'SCALAR', indices));

const mesh = doc.createMesh('column').addPrimitive(prim);
scene.addChild(doc.createNode('column').setMesh(mesh).setSkin(skin));

const glb = await new WebIO().writeBinary(doc);
const outPath = new URL('./assets/skinned-column.glb', import.meta.url);
await Deno.mkdir(new URL('./assets/', import.meta.url), { recursive: true });
await Deno.writeFile(outPath, glb);
console.log(`wrote ${outPath.pathname} (${glb.byteLength} bytes, ${vertexCount} verts, ${indices.length / 3} tris, ${JOINT_COUNT} joints)`);
