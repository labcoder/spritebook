# P0-T4 prep — test meshes for the auto-rig taste test

Three static (rig-free) CC0 test meshes in `../assets/`, plus ground-truth skeletons
extracted from the original rigs for scoring UniRig's predictions. Everything here is
spike material (throwaway by contract).

## Deliverables

| file | bytes | verts | tris | bounds (m) |
|---|---:|---:|---:|---|
| `assets/humanoid-static.glb` | 3,541,700 | 8,483 | 14,318 | x −0.929..0.929 · y −0.010..1.810 · z −0.163..0.128 |
| `assets/stylized-static.glb` | 128,876 | 3,158 | 3,812 | x −1.476..1.476 · y 0.026..3.911 · z −0.633..1.401 |
| `assets/asymmetric-static.glb` | 3,541,700 | 8,483 | 14,318 | x −0.929..**0.543** · y −0.010..1.810 · z −0.163..0.128 |
| `assets/humanoid-groundtruth-rig.json` | 19,562 | — | — | 65 joints, 1 root |
| `assets/stylized-groundtruth-rig.json` | 3,571 | — | — | 12 joints, 1 root |

All three .glb are far under the 10 MB budget and under UniRig's 50k-face internal cap
(largest is 14,318 tris). Every primitive has POSITION + NORMAL + a material; zero
skins/animations/JOINTS_*/WEIGHTS_* remain (see `validate.ts`).

Per-mesh counts (humanoid + asymmetric share topology): `Face` (hair) 646 v / 984 t ·
`Face.001` (eyes) 556 v / 768 t · `Sphere.005_Retopology.004` (body) 7,281 v / 12,566 t.
Stylized: `Giant` 3,158 v / 3,812 t, material `Atlas.001` (vertex-atlas texture).

## Sources & licenses (as displayed at download time, 2026-07-11)

**Humanoid — Quaternius "Universal Base Characters", Superhero_Male body**
- Pack page: <https://quaternius.com/packs/universalbasecharacters.html> — license shown:
  **CC0** ("Free to use in personal, educational and commercial projects", links to
  <https://creativecommons.org/publicdomain/zero/1.0/>).
- File downloaded from the pack's itch.io mirror (the quaternius.com download button is
  itch-backed): <https://quaternius.itch.io/universal-base-characters> — page shows
  "**CC0 License**" / "**Creative Commons Zero v1.0 Universal**". Author: Quaternius.
- File: `Universal Base Characters[Standard].zip`, **128,968,391 bytes** (listed 122 MB),
  anonymous free download — no account created. Extracted
  `Base Characters/Godot - UE/Superhero_Male_FullBody.gltf` (+ .bin + PNGs), repacked to
  `assets/src-humanoid-rigged.glb` (3,729,144 bytes) via `pack-source.ts`.
- Note: the free Standard tier contains only the two Superhero-proportion bodies (Regular
  and Teen are in the paid Source tier). Superhero_Male is the standard humanoid base
  used here: 1.81 m tall, T-pose, 65-joint UE-style rig (`clavicle_l`, `lowerarm_l`, …).

**Stylized/chunky — Quaternius "Giant" (Ultimate Monsters)**
- Item page: <https://poly.pizza/m/BldaiPtyJa> — page displays "**Public Domain (CC0)**"
  (metadata `Licence: "CC0 1.0"`), author **Quaternius**.
- Direct file: <https://static.poly.pizza/260aff73-1409-4a45-9746-b078229d8cf3.glb>,
  **245,620 bytes**, saved as `assets/src-stylized-rigged.glb`. No account needed.
- Clearly non-realistic proportions: 3.9 m tall, 2.95 m arm span, 12-joint blob rig,
  7 bundled animations (stripped).

**Rejected candidate:** poly.pizza's "Animated Base Character" (`poly.pizza/m/cwYvO5UauX`,
the same UBC body) — that item page displays "Creative Commons Attribution", not CC0, so
it fails the license-shown-on-page requirement. The quaternius.com/itch.io pack displays
CC0, hence the 122 MB zip route for the humanoid.

## Pipeline (re-run from this directory)

```
deno task all        # strip both rigs -> asymmetric -> validate
```
or individually with plain `deno run -A`:
```
deno run -A pack-source.ts <extracted>/Superhero_Male_FullBody.gltf ../assets/src-humanoid-rigged.glb
deno run -A strip-rig.ts ../assets/src-humanoid-rigged.glb ../assets/humanoid-static.glb ../assets/humanoid-groundtruth-rig.json
deno run -A strip-rig.ts ../assets/src-stylized-rigged.glb ../assets/stylized-static.glb ../assets/stylized-groundtruth-rig.json
deno run -A make-asymmetric.ts ../assets/humanoid-static.glb ../assets/humanoid-groundtruth-rig.json ../assets/asymmetric-static.glb
deno run -A validate.ts
```

### pack-source.ts (one-time bootstrap for the humanoid)
- Packs the extracted `.gltf` + external `.bin`/`.png` into one self-contained `.glb`.
- **Drops normal/occlusion/metallicRoughness/emissive textures** (baseColor textures and
  all factors kept): with them the humanoid GLB is ~15.5 MB, over the 10 MB budget, and
  the taste test consumes geometry. Materials still render (baseColor + factors).
- Filename fixups needed before packing: the Godot export references
  `T_Hair_1_Normal_png.png` / `T_Eye_Normal_png.png`, which don't exist in the zip —
  copies of `T_Hair_1_Normal.png` / `T_Eye_Normal.png` satisfy the references (they're
  dropped by the texture strip anyway).

### strip-rig.ts
- Writes the ground truth **first**: `{ source, jointCount, joints: [{ name, parentIndex,
  translation, worldPosition }] }`. `translation` is the joint's local rest translation
  (per task spec); `worldPosition` is added because UniRig-vs-truth comparison happens in
  world space. `parentIndex` is −1 for roots, otherwise an index into the same array.
- Then removes skins, animations (channels/samplers first), skinning vertex attributes,
  the entire original node hierarchy, and orphaned accessors; meshes re-root under the
  scene. Materials/textures untouched.
- **Rest-pose bake (the important part):** a skinned mesh's raw POSITION data is only
  world-space if `jointWorld · IBM = I` at rest. True for the Blender-exported humanoid;
  **false for the FBX-converted Giant**, whose skin matrices carry an ~86.6× scale plus
  rotations (raw positions span 6 cm!). The script LBS-evaluates
  `p' = Σ w_j (jointWorld_j · IBM_j) p` and bakes it into POSITION/NORMAL whenever the
  max deviation from identity exceeds 1e-5. Result: Giant at true world scale (3.9 m).
  Normals go through the blended upper-3×3 + renormalize (exact for the uniform
  scales/rotations these assets contain).

### make-asymmetric.ts — the "single-arm marking" mesh
- Heuristic (T-pose, character faces +Z, so the character's LEFT arm runs along **+X**):
  read `lowerarm_l` (elbow, world [0.463, 1.455, −0.073]) and `hand_l` (wrist,
  [0.706, 1.455, −0.065]) from the ground-truth JSON; select vertices with
  `x > elbow.x` and `|y − elbow.y| < forearmLen` and `|z − elbow.z| < forearmLen`
  (forearmLen = 0.244 m; the y/z band is pure safety — at T-pose nothing but the forearm
  and hand lies beyond the elbow plane, verified by the selection count and bounds).
- Transform: scale selected vertices about the elbow by **0.25**, then translate inward
  (−forearm direction) by 0.15 · forearmLen = [−0.037, −0.000, −0.001] m. Fixed
  constants, no randomness; double-run outputs are byte-identical.
- Stats: **selected 1,234 / 8,483 verts**; displacement mean **0.297 m**, max **0.387 m**
  (fingertip); bounds x-max **0.929 → 0.543** (left arm ends in a tucked nub ~0.08 m past
  the elbow; right arm untouched at −0.929). ASCII front-projection eyeballed: one full
  arm, one stump, torso/legs untouched.

## Determinism

Full pipeline re-run to a temp dir → SHA256 **identical** for all five outputs
(humanoid/stylized static GLBs, both ground-truth JSONs, asymmetric GLB).
sha256 (first 16 hex): `humanoid-static` 444458c41c59f995 · `stylized-static`
fd34116cb606758f · `asymmetric-static` ca3a6d008ca9ff8e · `humanoid-groundtruth`
90e41d1a6e53d0dc · `stylized-groundtruth` ba2ced1fb3917d90.

## Gotchas hit (worth knowing before p1 importer work)

1. **Do not mix `@gltf-transform/functions` with a pinned older core.**
   `functions@4.2.1` resolves its own `core@4.4.x` next to our pinned `core@4.2.1` — two
   Document classes in one graph (plus a native `sharp` dependency). These scripts use
   core only; the two "transforms" needed (orphan sweep, rest-pose bake) are hand-rolled.
2. **poly.pizza license labels differ per item** even for the same author/pack —
   check each item page; the UBC upload there is labeled CC-BY while the pack is CC0.
3. **FBX-converted GLBs hide scale in the skin matrices** (Giant: 86.6×). Any importer
   that strips or retargets rigs must evaluate rest-pose skinning, not trust raw
   POSITION data. This is exactly the D-012 canonicalization trap the
   `gltf-pipeline-processing` skill warns about, now with a concrete in-repo example.
4. `deno task` entries here set `"lock": false` — spike scripts shouldn't grow a lockfile
   or touch the root one (the root `deno.lock` already pins `core@4.2.1`).
