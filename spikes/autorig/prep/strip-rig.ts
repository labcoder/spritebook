// P0-T4 prep: strip a rigged .glb down to its static mesh (materials kept), exporting
// the original skeleton first as ground truth for scoring UniRig's predicted rig.
//
// Usage: deno run -A strip-rig.ts <in-rigged.glb> <out-static.glb> <out-groundtruth.json>
//
// Ground truth JSON: { source, jointCount, joints: [{ name, parentIndex, translation,
// worldPosition }] }. `translation` is the joint's LOCAL rest translation (as specced);
// `worldPosition` is added because rig comparison happens in world space.
//
// Rest-pose correctness: per the glTF spec a skinned mesh ignores its node's transform;
// the world-space rest mesh is LBS-evaluated: p' = Σ_j w_j · (jointWorld_j · IBM_j) · p.
// For Blender-exported rigs (the humanoid) rest == bind, every jointWorld·IBM is
// identity, and baking is skipped so vertex bytes stay untouched. For FBX-converted rigs
// (the Giant: an 86.6× scale plus rotations live in jointWorld·IBM) the skinning is baked
// into POSITION/NORMAL. Stripped skinned meshes then re-root under the scene with an
// IDENTITY transform; non-skinned mesh nodes (none in these assets, handled for safety)
// keep their baked world matrix instead.

import { WebIO, type Document, type Node, type Primitive } from 'npm:@gltf-transform/core@4.2.1';
import { basename } from 'node:path';

const [inPath, outGlbPath, outJsonPath] = Deno.args;
if (!inPath || !outGlbPath || !outJsonPath) {
  console.error('usage: deno run -A strip-rig.ts <in-rigged.glb> <out-static.glb> <out-groundtruth.json>');
  Deno.exit(1);
}

const io = new WebIO();
const doc: Document = await io.readBinary(await Deno.readFile(inPath));
const root = doc.getRoot();
const scene = root.getDefaultScene() ?? root.listScenes()[0];
if (!scene) throw new Error('no scene in input');

// ---------------------------------------------------------------- ground truth skeleton
const skins = root.listSkins();
if (skins.length === 0) throw new Error(`${inPath}: no skins — nothing to strip`);

// Union of joints across skins, preserving first-seen order (these assets have 1 skin).
const joints: Node[] = [];
const seen = new Set<Node>();
for (const skin of skins) {
  for (const j of skin.listJoints()) {
    if (!seen.has(j)) {
      seen.add(j);
      joints.push(j);
    }
  }
}

const parentOf = new Map<Node, Node>();
const walk = (n: Node) => {
  for (const c of n.listChildren()) {
    parentOf.set(c, n);
    walk(c);
  }
};
for (const n of scene.listChildren()) walk(n);

const groundtruth = {
  source: basename(inPath),
  jointCount: joints.length,
  joints: joints.map((j) => {
    const p = parentOf.get(j);
    const w = j.getWorldMatrix();
    return {
      name: j.getName(),
      parentIndex: p && seen.has(p) ? joints.indexOf(p) : -1,
      translation: [...j.getTranslation()],
      worldPosition: [w[12], w[13], w[14]],
    };
  }),
};
await Deno.writeTextFile(outJsonPath, JSON.stringify(groundtruth, null, 2) + '\n');

// ------------------------------------------------------------------------- strip rig
// 1) Bake rest-pose skinning into the vertex data of every skinned primitive.
type Mat4 = Float32Array;
const mul4 = (a: ArrayLike<number>, b: ArrayLike<number>, out: Mat4) => {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
};

const bakePrimitive = (prim: Primitive, skinMats: Mat4[], baked: Set<object>) => {
  const pos = prim.getAttribute('POSITION');
  if (!pos || baked.has(pos)) return; // shared accessors bake exactly once
  baked.add(pos);
  const nrm = prim.getAttribute('NORMAL');
  const jArrs: ArrayLike<number>[] = [];
  const wArrs: ArrayLike<number>[] = [];
  for (let set = 0; prim.getAttribute(`JOINTS_${set}`); set++) {
    jArrs.push(prim.getAttribute(`JOINTS_${set}`)!.getArray()!);
    wArrs.push(prim.getAttribute(`WEIGHTS_${set}`)!.getArray()!);
  }
  const p = pos.getArray() as Float32Array;
  const n = nrm ? (nrm.getArray() as Float32Array) : null;
  const m = new Float32Array(16);
  for (let v = 0; v < pos.getCount(); v++) {
    m.fill(0);
    let wsum = 0;
    for (let set = 0; set < jArrs.length; set++) {
      for (let k = 0; k < 4; k++) {
        const w = wArrs[set][v * 4 + k];
        if (w === 0) continue;
        wsum += w;
        const jm = skinMats[jArrs[set][v * 4 + k]];
        for (let i = 0; i < 16; i++) m[i] += w * jm[i];
      }
    }
    if (wsum === 0) continue; // unweighted vertex: leave untouched
    if (Math.abs(wsum - 1) > 1e-6) for (let i = 0; i < 16; i++) m[i] /= wsum; // renormalize sloppy weights
    const [x, y, z] = [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
    p[v * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    p[v * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    p[v * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (n) {
      // upper-3x3 then renormalize — exact for rotations/uniform scale (these assets)
      const [nx, ny, nz] = [n[v * 3], n[v * 3 + 1], n[v * 3 + 2]];
      let ox = m[0] * nx + m[4] * ny + m[8] * nz;
      let oy = m[1] * nx + m[5] * ny + m[9] * nz;
      let oz = m[2] * nx + m[6] * ny + m[10] * nz;
      const len = Math.hypot(ox, oy, oz) || 1;
      n[v * 3] = ox / len;
      n[v * 3 + 1] = oy / len;
      n[v * 3 + 2] = oz / len;
    }
  }
  pos.setArray(p); // mark dirty so min/max recompute on write
  if (n) nrm!.setArray(n);
};

const meshNodes = root.listNodes().filter((n) => n.getMesh());
let skinnedCount = 0;
let bakedCount = 0;
const bakedAccessors = new Set<object>();
for (const node of meshNodes) {
  const skin = node.getSkin();
  if (!skin) continue;
  const skinJoints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices()!.getArray() as Float32Array;
  const skinMats: Mat4[] = skinJoints.map((j, i) => {
    const out = new Float32Array(16);
    mul4(j.getWorldMatrix(), ibm.subarray(i * 16, i * 16 + 16), out);
    return out;
  });
  // rest == bind? then every skin matrix is identity and baking would only add float noise
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const dev = Math.max(...skinMats.map((m) => Math.max(...I.map((e, i) => Math.abs(m[i] - e)))));
  if (dev > 1e-5) {
    for (const prim of node.getMesh()!.listPrimitives()) bakePrimitive(prim, skinMats, bakedAccessors);
    bakedCount++;
  }
}

// 2) Detach every mesh onto a fresh scene-root node (identity for skinned — vertices are
//    now world-space — baked world matrix for non-skinned), so the original hierarchy
//    can be dropped wholesale.
for (const n of meshNodes) {
  const fresh = doc.createNode(n.getName()).setMesh(n.getMesh());
  if (n.getSkin()) {
    skinnedCount++;
  } else {
    fresh.setMatrix(n.getWorldMatrix());
  }
  n.setMesh(null);
  n.setSkin(null);
  scene.addChild(fresh);
}

// 3) Remove animations (channels + samplers first, then the animation itself).
const animCount = root.listAnimations().length;
for (const anim of root.listAnimations()) {
  for (const ch of anim.listChannels()) ch.dispose();
  for (const s of anim.listSamplers()) s.dispose();
  anim.dispose();
}

// 4) Remove skins, then the entire original node hierarchy (joints, armature, empties).
for (const skin of skins) skin.dispose();
const freshNodes = new Set(root.listNodes().filter((n) => n.getMesh() || n.getCamera()));
for (const n of root.listNodes()) {
  if (!freshNodes.has(n)) n.dispose();
}

// 5) Remove skinning vertex attributes from every primitive.
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    for (const sem of prim.listSemantics()) {
      if (sem.startsWith('JOINTS_') || sem.startsWith('WEIGHTS_')) prim.setAttribute(sem, null);
    }
  }
}

// 6) Orphan sweep: accessors (IBMs, keyframes, joint/weight data) referenced by nothing
//    but the root are gone from the graph's perspective — dispose so they aren't written.
let sweptAccessors = 0;
for (const acc of root.listAccessors()) {
  if (acc.listParents().every((p) => p.propertyType === 'Root')) {
    acc.dispose();
    sweptAccessors++;
  }
}

doc.getRoot().getAsset().generator = 'spritebook-p0t4-prep@0.1';

const glb = await io.writeBinary(doc);
await Deno.writeFile(outGlbPath, glb);

// ------------------------------------------------------------------------ report
let verts = 0;
let tris = 0;
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    verts += pos.getCount();
    const idx = prim.getIndices();
    tris += (idx ? idx.getCount() : pos.getCount()) / 3;
    const a = pos.getArray() as Float32Array;
    for (let i = 0; i < a.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (a[i + k] < min[k]) min[k] = a[i + k];
        if (a[i + k] > max[k]) max[k] = a[i + k];
      }
    }
  }
}
const f = (v: number[]) => `[${v.map((x) => x.toFixed(3)).join(', ')}]`;
console.log(
  `${basename(inPath)} -> ${basename(outGlbPath)} (${(glb.byteLength / 1024 / 1024).toFixed(2)} MB)\n` +
    `  groundtruth: ${joints.length} joints -> ${basename(outJsonPath)}\n` +
    `  stripped: ${skins.length} skins, ${animCount} animations, ${sweptAccessors} orphaned accessors, ` +
    `${skinnedCount}/${meshNodes.length} mesh nodes skinned, rest-pose bake applied to ${bakedCount} of them\n` +
    `  static: ${root.listMeshes().length} meshes, ${verts} verts, ${tris} tris, bounds min ${f(min)} max ${f(max)}`,
);
