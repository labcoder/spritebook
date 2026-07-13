// P0-T4 prep: pack a downloaded .gltf (+ external .bin/.png resources) into a single
// self-contained .glb, dropping normal/occlusion/metallicRoughness/emissive TEXTURES
// (factors and baseColor textures are kept). Rationale: the auto-rig taste test consumes
// geometry; the heavy normal/roughness maps alone push the humanoid past the ~10 MB
// output budget.
//
// Usage: deno run -A pack-source.ts <in.gltf> <out.glb>
// Deterministic: same input files -> same output bytes (glTF-Transform pinned at 4.2.1).
// No @gltf-transform/functions: it resolves its own copy of core (4.4.x) next to the
// pinned 4.2.1, and two core instances in one graph is exactly the kind of skew the
// importer-border skill warns about. The only transform needed here is a trivial
// orphan-texture sweep, done manually below.

import { type Document, WebIO } from 'npm:@gltf-transform/core@4.2.1';
import { basename, dirname, join } from 'node:path';

const [inPath, outPath] = Deno.args;
if (!inPath || !outPath) {
  console.error('usage: deno run -A pack-source.ts <in.gltf> <out.glb>');
  Deno.exit(1);
}

const json = JSON.parse(await Deno.readTextFile(inPath));
const dir = dirname(inPath);

// Load every externally-referenced resource, keyed by the exact uri string in the JSON.
const resources: Record<string, Uint8Array> = {};
const uris = new Set<string>();
for (const b of json.buffers ?? []) if (b.uri && !b.uri.startsWith('data:')) uris.add(b.uri);
for (const i of json.images ?? []) if (i.uri && !i.uri.startsWith('data:')) uris.add(i.uri);
for (const uri of uris) {
  resources[uri] = await Deno.readFile(join(dir, decodeURIComponent(uri)));
}

const io = new WebIO();
const doc: Document = await io.readJSON({ json, resources });

// Drop the heavy secondary maps; keep baseColor textures + all scalar/vector factors.
for (const mat of doc.getRoot().listMaterials()) {
  mat.setNormalTexture(null);
  mat.setOcclusionTexture(null);
  mat.setMetallicRoughnessTexture(null);
  mat.setEmissiveTexture(null);
}

// Manual orphan sweep: dispose textures no longer referenced by anything but the root.
for (const tex of doc.getRoot().listTextures()) {
  const parents = tex.listParents().filter((p) => p.propertyType !== 'Root');
  if (parents.length === 0) tex.dispose();
}

doc.getRoot().getAsset().generator = 'spritebook-p0t4-prep@0.1';

const glb = await io.writeBinary(doc);
await Deno.writeFile(outPath, glb);

const root = doc.getRoot();
console.log(
  `packed ${basename(inPath)} -> ${outPath} (${(glb.byteLength / 1024 / 1024).toFixed(2)} MB) | ` +
    `nodes=${root.listNodes().length} meshes=${root.listMeshes().length} ` +
    `skins=${root.listSkins().length} joints=${root.listSkins()[0]?.listJoints().length ?? 0} ` +
    `anims=${root.listAnimations().length} mats=${root.listMaterials().length} tex=${root.listTextures().length}`,
);
