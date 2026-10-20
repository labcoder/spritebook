# Export validation

This page is for contributors working in the repository. The release zips do not include the
repository, and the commands here assume a checkout.

Exporters are pure projections of the `BakeManifest` — same manifest in, byte-identical files out.
Validation has three tiers. Normal suites check format and byte stability. Opt-in consumer smokes
and manual review qualify actual engine/editor behavior; F7 requires those runs before a release
claims support. A skipped engine check is not a passing import.

## Tier 1 — automated, every CI run

- **Structural**: `packages/export/tres-parse.ts` strictly parses every `.tres` we emit and
  cross-checks it against the manifest (regions in bounds, frame counts per animation, referenced
  pages exist, `load_steps` arithmetic, and every frame's ANCHOR — where a default
  `AnimatedSprite2D` puts the node origin — landing on the pivot the bake recorded).
  Aseprite/TexturePacker JSON is parsed back and checked for rect/timing metadata and pivots where
  the format supports them. Aseprite JSON carries neither pivots nor a loop boolean. Strips are
  decoded and pixel-compared against the atlas rects.
- **Byte-stability**: two independent bakes of identical inputs → all exporter outputs compared
  byte-for-byte (volatile manifest fields — `createdAt`, `metrics.wallTimeS`, `metrics.cacheHitPct`
  — must never be projected).

## Tier 2 — gated real-engine smoke (opt-in, not in CI)

| Command                 | Required local prerequisite                                        | What it checks                                                                              |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `npm run test:godot`    | `GODOT4_BIN`                                                       | Real Godot loads the exported SpriteFrames and expected animations                          |
| `npm run test:aseprite` | `ASEPRITE_BIN`                                                     | Real Aseprite imports the PNG grid, preserves cells/frame count and accepts an explicit tag |
| `npm run test:phaser`   | `SPRITEBOOK_CDP_PORT` and the installed development Phaser package | Real browser/Phaser parses the exported JSON Hash and frame rectangles                      |
| `npm run test:unity`    | `UNITY_BIN` and `SPRITEBOOK_TP_IMPORTER`                           | Real Unity plus the user-supplied TexturePacker importer creates the named sprite slices    |

These scripts build the current code before running their lane. They skip when their prerequisite is
unset; a configured but unusable engine/importer fails. Record the exact version, artifact and
result for a release rather than inferring native consumer support from JSON-only checks. Unity
remains explicitly unverified in the current migration evidence. See the
[F7 gates](../future/roadmap.md#f7--release-the-migrated-application).

## Tier 3 — release review checklist (Godot 4)

1. Create a fresh Godot 4 project; copy an export (`<char>.tres` + `atlas_lit_*.png`) into it.
2. Open the project — the import must complete with **no errors or reimport warnings**.
3. Add an `AnimatedSprite2D`; assign the `.tres` as its SpriteFrames. Leave `centered` and `offset`
   at their defaults — the exported `AtlasTexture.margin` already anchors the node origin on the
   baked pivot.
4. Confirm every animation `idle_d00 … idle_dNN` appears; each shows the correct frame count. Put
   the node on a tile boundary and confirm the character STANDS on it in every direction: the node
   origin must sit at the feet, not at the middle of the cell.
5. Play each direction: frames advance at the exported fps, loop cleanly, and show the correct
   character orientation (the asymmetric fixture's single arm makes wrong directions unmissable).
6. Toggle nearest-neighbor filtering on the texture; make sure no bleed shows from neighboring atlas
   cells at the sprite edges.
7. Repeat 3–5 in Phaser 3 with the TexturePacker JSON (`this.load.atlas`) and in Aseprite (`File →
   Import Sprite Sheet` on the PNG; Aseprite does not read the JSON — see docs/engines/aseprite.md)
   as consumer spot-checks.
