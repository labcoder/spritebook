---
name: gltf-pipeline-processing
description: Reading, validating, transforming, and writing glTF with glTF-Transform in the importer border and asset pipeline. Use this skill whenever code touches 3D model files — normalizing uploads (glb/gltf/fbx/obj/vrm) into canonical glTF, cleaning scenes, accessing skins/joints/inverse bind matrices, merging or splitting assets, enforcing orientation and scale conventions, or making glTF output byte-deterministic for content hashing. Consult it before adding any new import path or asset transform, even a "trivial" one.
---

# glTF processing at the importer border

Everything becomes canonical glTF at the door (decision D-012); downstream code speaks exactly one
format. The library for all glTF surgery is **glTF-Transform** (`@gltf-transform/core`,
`/extensions`, `/functions`) — it manages indices and byte offsets that hand-rolled JSON editing
always corrupts.

## I/O setup

```ts
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.decoder': MeshoptDecoder,
  });
const doc = await io.read(path); // .glb or .gltf
const bytes = await io.writeBinary(doc); // Uint8Array for the asset store
```

Register extensions and **decoders up front** — reads of Draco/meshopt-compressed inputs fail
without them, and user files arrive compressed constantly. Avoid Node-only helpers (e.g. sharp-based
`textureCompress`) in Deno code paths; texture work happens elsewhere in this pipeline anyway.

## The canonicalization recipe

```ts
await doc.transform(resample(), prune(), dedup(), weld());
```

- **Decode compression on ingest.** Canonical assets are stored _uncompressed_: deterministic,
  hashable, and downstream modules never need decoders.
- **Do not `quantize()` canonical assets.** It is lossy, moves vertices, and silently runs its own
  prune/dedup — wrong properties for a source-of-truth artifact.
- **`prune()`/`dedup()` need supervision.** Defaults can drop or merge things skinned characters
  need; real-world models have been broken by aggressive prune/dedup passes. Configure
  `propertyTypes`/`keepAttributes` deliberately, and after every transform chain run the validation
  report and diff node/mesh/skin/joint counts against pre-transform. A canonicalization that changes
  skin count is a failed import, not a cleanup.

Custom passes use the standard composable shape — a function returning `(document) => { ... }` — and
belong in the same `transform()` chain so they're recorded and ordered.

## Conventions enforced at the border (repo law)

- **+Y up, meters, character faces +Z** (the glTF spec's forward). Bake any corrective rotation into
  the mesh (`clearNodeTransform`/`transformMesh` style), don't leave it on a node for downstream
  code to forget.
- **VRM trap:** VRM 0.x characters face **−Z**; rotate 180° on import. VRM 1.0 faces +Z. Detect the
  VRM version before orienting.
- **Scale:** measure standing height from bounds, record the raw value in the import report, rescale
  to the manifest-declared height. Uniform scale only — the renderer's skinning normal math assumes
  it.

## Skinning access and validation

```ts
for (const skin of doc.getRoot().listSkins()) {
  const joints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices()?.getArray(); // Float32Array, 16 per joint
}
```

Validate on import: every `JOINTS_0` index < joint count; `WEIGHTS_0` rows sum ≈ 1.0 (renormalize
when they don't — generators are sloppy); inverse bind matrices present and finite. Emit failures as
actionable errors naming the mesh and joint, never a stack trace.

## Determinism for content hashing

The asset store hashes bytes, so writes must be reproducible:

- Pin the glTF-Transform version; set a fixed generator string
  (`doc.getRoot().getAsset().generator = 'spritebook-import@<toolver>'`); strip volatile `extras`
  and any timestamps.
- **The double-import test is mandatory:** import the same source file twice → identical sha256. It
  lives in CI (P1-T4 acceptance) and is the tripwire for library upgrades changing serialization
  order. If an upgrade ever breaks byte stability, hash a canonical JSON projection of the Document
  instead — but exhaust the bytes-stable route first.

## Formats glTF-Transform does not read

FBX and OBJ are **conversion steps before** the border, not import paths inside it:

- OBJ → `obj2gltf`; FBX → `FBX2glTF` binary or assimp CLI. No Autodesk FBX SDK anywhere — licensing.
- Converters are versioned tools: record name + version in the character's provenance, because
  converter upgrades change bytes and therefore hashes.

## Import report

Every import emits a report (as an NDJSON `artifact` event): counts of
nodes/meshes/primitives/skins/joints/materials/textures/animations, detected source convention
(orientation, scale), fixes applied, and warnings (missing normals → generated; missing tangents →
deferred to render prep via mikktspace, not fixed here). The report is what makes a failed import
debuggable from CI logs alone.
