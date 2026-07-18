/**
 * Extract a small, committable clip-subset fixture from the maintainer's local
 * UAL download (CC0 1.0 — see the pack's License.txt; that license is what
 * makes the converted subset committable, D-013). Keeps ONLY the skeleton node
 * hierarchy + two animations (Walk_Loop — the acceptance clip — and A_TPose
 * for rest-pose alignment tests); the mesh/skin are dropped. Retarget tests
 * need rest pose + tracks, not geometry; the bundled pack (with the full clip
 * set) is BUILT from the local download by the pack tooling, not committed
 * through this fixture.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-ffi \
 *     packages/anim/fixtures/_extract-ual.ts [ualGlbPath]
 */
import { NodeIO } from '@gltf-transform/core';
import { prune, resample } from 'npm:@gltf-transform/functions@4.4.1';

const SRC = Deno.args[0] ??
  'C:/dev/vendor-assets/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb';
const KEEP = ['Walk_Loop', 'A_TPose'];

const here = new URL('.', import.meta.url);
const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');

const io = new NodeIO();
const doc = await io.readBinary(await Deno.readFile(SRC));
const root = doc.getRoot();

for (const anim of root.listAnimations()) {
  if (KEEP.includes(anim.getName())) continue;
  // disposing an Animation does NOT dispose its samplers — their accessors
  // survive prune() as orphans (measured: 4.8 MB of them). Dispose explicitly.
  for (const ch of anim.listChannels()) ch.dispose();
  for (const s of anim.listSamplers()) s.dispose();
  anim.dispose();
}
for (const skin of root.listSkins()) skin.dispose();
for (const mesh of root.listMeshes()) mesh.dispose();
for (const node of root.listNodes()) {
  if (node.getMesh()) node.dispose();
}
// resample drops redundant dense-baked keyframes (lossless within tolerance);
// UAL ships every joint keyed every frame, most of them static
await doc.transform(resample(), prune());

const kept = root.listAnimations().map((a) => a.getName());
if (kept.length !== KEEP.length) {
  throw new Error(`expected ${KEEP.join(',')} — got ${kept.join(',')}`);
}
const bytes = await io.writeBinary(doc);
const out = win(new URL('ual-subset.glb', here));
await Deno.writeFile(out, bytes);
console.log(`ual-subset.glb: ${bytes.length} B, clips: ${kept.join(', ')}`);
