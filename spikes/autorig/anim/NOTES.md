# P0-T4 — CC0 humanoid animation clips (Mesh2Motion bundled libraries)

Spike asset acquisition notes. Throwaway by contract (see `docs/internal/roadmap/p0.md`).

## Files

| File | Bytes | SHA256 |
|---|---|---|
| `human-base-animations.glb` | 5,656,648 | `406EB0A8DC4AB366E623B79B6E3005A4951392E1BDA78AE39C1099D31147733C` |
| `human-addon-animations.glb` | 5,292,804 | `A0D64D555E0D492026B72D58BF8E16C5E86779295F9093E376DCC001915C2C95` |

## Source & provenance

Downloaded 2026-07-11 from the Mesh2Motion open-source app repo, pinned to commit
`626d41d4d4670cdb4a788154762effe0a108ac24` ("rebuild human animation previews", 2026-07-10):

- https://raw.githubusercontent.com/scottpetrovic/mesh2motion-app/626d41d4d4670cdb4a788154762effe0a108ac24/static/animations/human-base-animations.glb
- https://raw.githubusercontent.com/scottpetrovic/mesh2motion-app/626d41d4d4670cdb4a788154762effe0a108ac24/static/animations/human-addon-animations.glb

Repo: https://github.com/scottpetrovic/mesh2motion-app (live app: https://app.mesh2motion.org/)

Other libraries at the same path (not downloaded, creature clips for Track B later):
`bird-`, `dragon-`, `fox-`, `kaiju-`, `shark-`, `snake-`, `spider-animations.glb`.
The repo also carries CMU mocap FBX files under `static/animations/CarnegieMellonAnimations/` —
those are CMU-licensed (free for any use), not part of this download.

## License evidence

README.md at the pinned commit states, verbatim:

> "The code and platform are all licensed under the very permissive MIT license."
>
> "The art assets (3d models, rigs, animations) are all licensed under CC0."
>
> "I tried making everything as open as possible to remix, change, and build upon for the future."

This matches the BOM row in `docs/dependencies.md` § Animation: "Mesh2Motion assets — art CC0,
code MIT — ✓ explicitly free for personal/commercial". The animation glbs are art assets ⇒ CC0.

## Inspection results

Via `inspect-glb.ts` (Deno + `npm:@gltf-transform/core@4.2.1`, pattern from `spikes/webgpu/asset.ts`).
Run: `deno run --no-lock --allow-read inspect-glb.ts human-base-animations.glb human-addon-animations.glb`
(`--no-lock` avoids touching the repo lockfile from a spike; a stale sandbox npm cache needed a
fresh `DENO_DIR` once.)

### Common structure (both files)

- glTF 2.0, generator `glTF-Transform v4.2.1`. 1 scene, 68 nodes, 1 mesh, **1 skin, 66 joints**, 1 material.
- **Skinned mesh included: YES** — node `Mannequin`, mesh `Mannequin.001` (~7.4k verts, 1 primitive),
  bound to skin `Armature`. So these files are usable stand-alone (animation + proxy body), not
  armature-only clip containers.
- **Joint naming convention: bare snake_case with `_l`/`_r` side suffixes — the UE-mannequin-style
  scheme, NOT `mixamorig:`-prefixed, no namespace colons.**
  First 12 joints in order: `root, pelvis, spine_01, spine_02, spine_03, neck_01, head, head_leaf,
  clavicle_l, upperarm_l, lowerarm_l, hand_l`. Hierarchy root joint `root`, whose parent is the
  (non-joint) node `Armature`.
- Every clip animates all 66 joints with `translation`, `rotation` and `scale` channels
  (198 channels = 66 x 3). Retargeting can drop translation+scale on everything except `root`/`pelvis`.

### human-base-animations.glb — 87 clips

Locomotion & staples (name — duration): `Idle_A` — 3.125 s, `Walk` — 1.667 s, `Jog` — 1.167 s,
`Sprint` — 0.833 s, `Crouch_Idle` — 3.667 s, `Crouch_Walk` — 2.5 s, `Walk_Carry` — 2 s,
`Walk_Formal` — 1.667 s, `Jump_Start/air/Land`, `Roll` — 1.833 s, plus combat/sword/pistol/spell,
farm/interact, swim, zombie sets. Root-motion variants carry an `_RM` suffix
(`Roll_RM`, `Hit_Knockback_RM`, `ClimbUp_1m_RM`, `Sword_Dash_RM`, ...). Clips start at t=0.

### human-addon-animations.glb — 75 clips

`Walk_Female` — 1.333 s, `Walk_Large` — 1.375 s, `Walk_Stealth` — 1.458 s, `Walk_Backwards` — 0.958 s,
`Run_Anime` — 0.708 s, `Run_Female` — 0.792 s, `Run_Stealth` — 0.5 s, `Strafe_left/right` — 0.958 s,
`Idle_Subtle` — 2.542 s, dodge set (plain + `_RM`), dance/emote/climb/zombie sets, `Rest Pose` — 0.375 s.
Quirk: every addon clip starts at **t = 0.042 s** (one frame at 24 fps), not t = 0 — normalize on import.

### Data quirks to remember

- `Hit_Chest` (base) has 199 channels / **67 targets** — one non-joint node is animated too.
- `Sword_Regular_C_RM` (base) has **396 channels** (doubled) — likely duplicated channel export.
- Addon clip names mix `Snake_Case` and `Space Separated` (`"Bow Pull Back"`); don't assume a
  single naming style for clip IDs.
- The two files' mannequin meshes differ slightly (7391 vs 7399 verts) — same skeleton though.

## Verdict for P0-T4

One universal 66-joint humanoid rig across ~162 CC0 clips with a bundled skinned mannequin =
exactly one retarget profile needed for the spike, and the mannequin gives us a known-good
"already rigged" input for the contact-sheet renderer before UniRig outputs exist.
