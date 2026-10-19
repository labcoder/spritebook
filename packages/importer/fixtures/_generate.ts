/**
 * Importer fixture generator (deterministic; run once, files are checked in):
 *  - cube.obj             hand-built OBJ, no normals (exercises the generate-normals fix)
 *  - vrm0-arrow.gltf      minimal VRM 0.x-marked glTF whose asymmetric arrow faces -Z
 *                         (the VRM 0.x convention the importer must rotate to +Z)
 *  - skinned-column.glb   copied from the P0-T2 spike (procedural, hermetic, CC0-free)
 *
 * The rigged-cube.fbx fixture is generated separately by _generate-fbx.py (bpy).
 *
 *   deno run --allow-read --allow-write packages/importer/fixtures/_generate.ts
 */

const here = new URL('.', import.meta.url);

// --- cube.obj: unit cube resting on y=0, 0.5 m tall (tests height rescale) --
const objLines = [
  '# spritebook importer fixture - unit cube, no normals on purpose',
  'o cube',
];
const s = 0.25; // half-extent; cube spans y in [0, 0.5]
const corners: Array<[number, number, number]> = [
  [-s, 0, -s],
  [s, 0, -s],
  [s, 0.5, -s],
  [-s, 0.5, -s],
  [-s, 0, s],
  [s, 0, s],
  [s, 0.5, s],
  [-s, 0.5, s],
];
for (const [x, y, z] of corners) objLines.push(`v ${x} ${y} ${z}`);
const quads = [
  [1, 2, 3, 4],
  [5, 8, 7, 6],
  [1, 5, 6, 2],
  [2, 6, 7, 3],
  [3, 7, 8, 4],
  [5, 1, 4, 8],
];
for (const q of quads) objLines.push(`f ${q.join(' ')}`);
await Deno.writeTextFile(new URL('cube.obj', here), objLines.join('\n') + '\n');

// --- vrm0-arrow.gltf: 4 verts, 2 tris; single "nose" vertex at z = -1 -------
const positions = new Float32Array([
  0,
  0.5,
  -1, // nose (unique extreme; faces -Z pre-import)
  -0.5,
  0.5,
  1, // tail left
  0.5,
  0.5,
  1, // tail right
  0,
  0,
  1, // tail bottom (gives the mesh height + a feet plane)
]);
const indices = new Uint16Array([0, 1, 2, 1, 3, 2]);
const posBytes = new Uint8Array(positions.buffer);
const idxBytes = new Uint8Array(indices.buffer);
const buffer = new Uint8Array(posBytes.length + idxBytes.length);
buffer.set(posBytes, 0);
buffer.set(idxBytes, posBytes.length);
let b64 = '';
{
  let bin = '';
  for (const b of buffer) bin += String.fromCharCode(b);
  b64 = btoa(bin);
}
const gltf = {
  asset: { version: '2.0', generator: 'spritebook-fixture' },
  extensionsUsed: ['VRM'],
  extensions: { VRM: { exporterVersion: 'UniVRM-0.99.fixture', specVersion: '0.0' } },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'arrow' }],
  meshes: [{ name: 'arrow', primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: 4,
      type: 'VEC3',
      min: [-0.5, 0, -1],
      max: [0.5, 0.5, 1],
    },
    { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBytes.length },
    { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length },
  ],
  buffers: [
    { byteLength: buffer.length, uri: `data:application/octet-stream;base64,${b64}` },
  ],
};
await Deno.writeTextFile(new URL('vrm0-arrow.gltf', here), JSON.stringify(gltf, null, 2) + '\n');

// --- skinned-column.glb: reuse the committed renderer fixture ---------------
const src = new URL('../../render/fixtures/skinned-column.glb', here);
await Deno.writeFile(new URL('skinned-column.glb', here), await Deno.readFile(src));

console.log('importer fixtures written: cube.obj, vrm0-arrow.gltf, skinned-column.glb');
