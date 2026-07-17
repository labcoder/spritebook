# Export validation

Exporters are pure projections of the `BakeManifest` — same manifest in, byte-identical files out.
Their correctness is proven in three tiers; per maintainer decision (2026-07-15), **real-engine
smokes run once at the very end of the project**, not per phase.

## Tier 1 — automated, every CI run

- **Structural**: `packages/export/tres-parse.ts` strictly parses every `.tres` we emit and
  cross-checks it against the manifest (regions in bounds, frame counts per animation, referenced
  pages exist, `load_steps` arithmetic). Aseprite/TexturePacker JSON is parsed back and checked for
  rect/pivot fidelity. Strips are decoded and pixel-compared against the atlas rects.
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
3. Add an `AnimatedSprite2D`; assign the `.tres` as its SpriteFrames.
4. Confirm every animation `idle_d00 … idle_dNN` appears; each shows the correct frame count.
5. Play each direction: frames advance at the exported fps, loop cleanly, and show the correct
   character orientation (the asymmetric fixture's single arm makes wrong directions unmissable).
6. Toggle nearest-neighbor filtering on the texture; verify no bleed from neighboring atlas cells at
   the sprite edges.
7. Repeat 3–5 in Phaser 3 with the TexturePacker JSON (`this.load.atlas`) and in Aseprite
   (`File → Import Sprite Sheet` honors the JSON) as consumer spot-checks.
