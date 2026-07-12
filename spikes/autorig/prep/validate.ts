// P0-T4 prep: validate the three static test meshes. Re-loads each .glb with
// glTF-Transform and asserts the properties the auto-rig taste test depends on:
//   - zero skins, zero animations, zero JOINTS_*/WEIGHTS_* vertex attributes
//   - every primitive has POSITION + NORMAL and a material
//   - reports vertex/triangle counts, materials, bounds, file size (budget: < 10 MB)
// Also sanity-checks the ground-truth rig JSONs (jointCount, parentIndex ranges, roots).
//
// Usage: deno run -A validate.ts   (paths are fixed relative to this script)

import { WebIO, type Document } from 'npm:@gltf-transform/core@4.2.1';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const GLBS = ['humanoid-static.glb', 'stylized-static.glb', 'asymmetric-static.glb'];
const GTS = ['humanoid-groundtruth-rig.json', 'stylized-groundtruth-rig.json'];
const SIZE_BUDGET = 10 * 1024 * 1024;

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  FAIL: ${msg}`);
};

const io = new WebIO();
for (const name of GLBS) {
  const path = join(assetsDir, name);
  const bytes = await Deno.readFile(path);
  const doc: Document = await io.readBinary(bytes);
  const root = doc.getRoot();
  console.log(`${name} (${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB)`);

  if (bytes.byteLength >= SIZE_BUDGET) fail(`file exceeds 10 MB budget`);
  if (root.listSkins().length !== 0) fail(`${root.listSkins().length} skins remain`);
  if (root.listAnimations().length !== 0) fail(`${root.listAnimations().length} animations remain`);

  let verts = 0;
  let tris = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of root.listMeshes()) {
    let mv = 0;
    let mt = 0;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) {
        fail(`mesh "${mesh.getName()}": primitive without POSITION`);
        continue;
      }
      if (!prim.getAttribute('NORMAL')) fail(`mesh "${mesh.getName()}": primitive without NORMAL`);
      if (!prim.getMaterial()) fail(`mesh "${mesh.getName()}": primitive without material`);
      for (const sem of prim.listSemantics()) {
        if (sem.startsWith('JOINTS_') || sem.startsWith('WEIGHTS_')) {
          fail(`mesh "${mesh.getName()}": skinning attribute ${sem} remains`);
        }
      }
      mv += pos.getCount();
      const idx = prim.getIndices();
      mt += (idx ? idx.getCount() : pos.getCount()) / 3;
      const a = pos.getArray() as Float32Array;
      for (let i = 0; i < a.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (a[i + k] < min[k]) min[k] = a[i + k];
          if (a[i + k] > max[k]) max[k] = a[i + k];
        }
      }
    }
    const mats = mesh.listPrimitives().map((p) => p.getMaterial()?.getName() ?? '(none)');
    console.log(`  mesh "${mesh.getName()}": ${mv} verts, ${mt} tris, materials [${mats.join(', ')}]`);
    verts += mv;
    tris += mt;
  }
  const f = (v: number[]) => `[${v.map((x) => x.toFixed(3)).join(', ')}]`;
  console.log(`  total: ${verts} verts, ${tris} tris | bounds min ${f(min)} max ${f(max)}`);
}

for (const name of GTS) {
  const gt = JSON.parse(await Deno.readTextFile(join(assetsDir, name)));
  console.log(`${name}`);
  if (gt.jointCount !== gt.joints.length) fail(`jointCount ${gt.jointCount} != joints.length ${gt.joints.length}`);
  const roots = gt.joints.filter((j: { parentIndex: number }) => j.parentIndex === -1).length;
  if (roots < 1) fail('no root joint (parentIndex -1)');
  for (const [i, j] of gt.joints.entries()) {
    if (!j.name) fail(`joint ${i} has no name`);
    if (j.parentIndex < -1 || j.parentIndex >= gt.joints.length) fail(`joint ${i} parentIndex out of range`);
    if (j.parentIndex === i) fail(`joint ${i} is its own parent`);
  }
  console.log(`  ${gt.jointCount} joints, ${roots} root(s), source ${gt.source}`);
}

if (failures > 0) {
  console.error(`\n${failures} validation failure(s)`);
  Deno.exit(1);
}
console.log('\nall validations passed');
