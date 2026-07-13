// P0-T4 prep: build the asymmetric test mesh — shrink the character's LEFT forearm+hand
// to a stump so the roadmap's "single-arm marking" case exists in the taste test.
//
// Usage: deno run -A make-asymmetric.ts <in-static.glb> <in-groundtruth.json> <out.glb>
//
// Heuristic (documented per task):
//   The humanoid is a T-pose facing +Z, so the character's LEFT arm runs along +X
//   (ground truth: lowerarm_l at x=+0.463, hand_l at x=+0.706, fingertips at x=+0.929;
//   nothing else on the body reaches past the elbow plane). Rather than hardcoding
//   x > 0.46, the elbow/wrist joints are read from the ground-truth rig JSON exported by
//   strip-rig.ts, and vertices are selected by:
//     v.x > elbow.x  AND  |v.y - elbow.y| < forearmLen  AND  |v.z - elbow.z| < forearmLen
//   (the y/z band is pure safety; at T-pose nothing else lives beyond the elbow plane).
//   Selected vertices are scaled about the elbow point by SCALE = 0.25, then translated
//   INWARD (toward the body, -forearm direction) by 0.15 * forearmLen, so the arm ends
//   in a small tucked nub just past the elbow — a visible stump.
//
// Deterministic: fixed constants, no randomness; same input bytes -> same output bytes.
// Normals are left untouched: uniform scale about a point + translation is a similarity
// transform with no rotation, so normal directions remain valid.

import { type Document, WebIO } from 'npm:@gltf-transform/core@4.2.1';
import { basename } from 'node:path';

const SCALE = 0.25;
const INWARD_FRAC = 0.15; // of forearm length, toward the body

const [inPath, gtPath, outPath] = Deno.args;
if (!inPath || !gtPath || !outPath) {
  console.error(
    'usage: deno run -A make-asymmetric.ts <in-static.glb> <in-groundtruth.json> <out.glb>',
  );
  Deno.exit(1);
}

interface GtJoint {
  name: string;
  parentIndex: number;
  translation: number[];
  worldPosition: number[];
}
const gt = JSON.parse(await Deno.readTextFile(gtPath)) as { joints: GtJoint[] };

const findJoint = (patterns: RegExp[]): GtJoint => {
  for (const re of patterns) {
    const j = gt.joints.find((j) => re.test(j.name.toLowerCase()));
    if (j) return j;
  }
  throw new Error(`no joint matches ${patterns.map((p) => p.source).join(' | ')}`);
};
// Primary: UE-style names used by the Universal Base Characters rig. Fallbacks cover
// Blender-style .L suffixes should the input rig ever change.
const elbowJ = findJoint([/^lowerarm_l$/, /^(lowerarm|forearm|elbow).*(_l|\.l|left)$/]);
const wristJ = findJoint([/^hand_l$/, /^(hand|wrist).*(_l|\.l|left)$/]);

const elbow = elbowJ.worldPosition;
const wrist = wristJ.worldPosition;
if (elbow[0] <= 0) {
  throw new Error(
    `left elbow at x=${elbow[0]} — expected +X for a +Z-facing character; heuristic invalid`,
  );
}
const dirRaw = [wrist[0] - elbow[0], wrist[1] - elbow[1], wrist[2] - elbow[2]];
const forearmLen = Math.hypot(...dirRaw);
const dir = dirRaw.map((c) => c / forearmLen);
const inward = dir.map((c) => -c * INWARD_FRAC * forearmLen);

const io = new WebIO();
const doc: Document = await io.readBinary(await Deno.readFile(inPath));
const root = doc.getRoot();
if (root.listSkins().length > 0) throw new Error('input still has skins — run strip-rig.ts first');

let selected = 0;
let total = 0;
let maxDisp = 0;
let sumDisp = 0;
const before = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
const after = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
const grow = (b: typeof before, x: number, y: number, z: number) => {
  const v = [x, y, z];
  for (let k = 0; k < 3; k++) {
    if (v[k] < b.min[k]) b.min[k] = v[k];
    if (v[k] > b.max[k]) b.max[k] = v[k];
  }
};

const edited = new Set<object>(); // shared accessors edit exactly once
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos || edited.has(pos)) continue;
    edited.add(pos);
    const a = pos.getArray() as Float32Array;
    for (let i = 0; i < a.length; i += 3) {
      total++;
      const [x, y, z] = [a[i], a[i + 1], a[i + 2]];
      grow(before, x, y, z);
      const inBand = x > elbow[0] &&
        Math.abs(y - elbow[1]) < forearmLen &&
        Math.abs(z - elbow[2]) < forearmLen;
      if (inBand) {
        selected++;
        const nx = elbow[0] + SCALE * (x - elbow[0]) + inward[0];
        const ny = elbow[1] + SCALE * (y - elbow[1]) + inward[1];
        const nz = elbow[2] + SCALE * (z - elbow[2]) + inward[2];
        const d = Math.hypot(nx - x, ny - y, nz - z);
        sumDisp += d;
        if (d > maxDisp) maxDisp = d;
        a[i] = nx;
        a[i + 1] = ny;
        a[i + 2] = nz;
      }
      grow(after, a[i], a[i + 1], a[i + 2]);
    }
    pos.setArray(a); // mark dirty so accessor min/max recompute on write
  }
}
if (selected === 0) throw new Error('selection empty — heuristic matched no vertices');

doc.getRoot().getAsset().generator = 'spritebook-p0t4-prep@0.1';
const glb = await io.writeBinary(doc);
await Deno.writeFile(outPath, glb);

const f = (v: number[]) => `[${v.map((x) => x.toFixed(3)).join(', ')}]`;
console.log(
  `${basename(inPath)} -> ${basename(outPath)} (${
    (glb.byteLength / 1024 / 1024).toFixed(2)
  } MB)\n` +
    `  elbow(${elbowJ.name}) ${f(elbow)}  wrist(${wristJ.name}) ${f(wrist)}  forearmLen ${
      forearmLen.toFixed(3)
    }\n` +
    `  selected ${selected}/${total} verts (x > ${
      elbow[0].toFixed(3)
    }), scale ${SCALE} about elbow, ` +
    `inward ${f(inward)}\n` +
    `  displacement: mean ${(sumDisp / selected).toFixed(3)} m, max ${maxDisp.toFixed(3)} m\n` +
    `  bounds before min ${f(before.min)} max ${f(before.max)}\n` +
    `  bounds after  min ${f(after.min)} max ${f(after.max)}`,
);
