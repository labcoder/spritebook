# Export validation

This page is for contributors working in the repository. The release zips do not
include the repository, and the commands here assume a checkout.

Exporters are pure projections of the `BakeManifest` — same manifest in, byte-identical files out.
Their correctness is proven in three tiers; by standing decision, **real-engine
smokes run once at the very end of the project**, not per phase.

## Tier 1 — automated, every CI run

- **Structural**: `packages/export/tres-parse.ts` strictly parses every `.tres` we emit and
  cross-checks it against the manifest (regions in bounds, frame counts per animation, referenced
  pages exist, `load_steps` arithmetic, and every frame's ANCHOR — where a default
  `AnimatedSprite2D` puts the node origin — landing on the pivot the bake recorded).
  Aseprite/TexturePacker JSON is parsed back and checked for rect/pivot fidelity. Strips are decoded
  and pixel-compared against the atlas rects.
- **Byte-stability**: two independent bakes of identical inputs → all exporter outputs compared
  byte-for-byte (volatile manifest fields — `createdAt`, `metrics.wallTimeS`, `metrics.cacheHitPct`
  — must never be projected).

## Tier 2 — gated real-engine smoke (opt-in, not in CI)

Set `GODOT4_BIN` to a Godot 4.x binary and run:

```
deno test --allow-all packages/export/godot_smoke_test.ts
```

The test imports the exported project headlessly and asserts the SpriteFrames resource loads with
the expected animations. It is skipped (loudly, as `ignored`) when `GODOT4_BIN` is unset.

## Tier 3 — end-of-project manual checklist (Godot 4)

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
6. Toggle nearest-neighbor filtering on the texture; make sure no bleed shows from neighboring atlas cells at
   the sprite edges.
7. Repeat 3–5 in Phaser 3 with the TexturePacker JSON (`this.load.atlas`) and in Aseprite
   (`File → Import Sprite Sheet` on the PNG; Aseprite does not read the JSON — see
   docs/engines/aseprite.md) as consumer spot-checks.
