# AGENTS.md — canonical agent instructions

This is the single source of agent truth for SpriteBook. `CLAUDE.md` points here. Scoped `AGENTS.md` files in `docs/architecture/` and `docs/design/` supplement this file for their domains.

## Orientation (read in this order, first session in a fresh context)

1. `README.md` — what this is
2. `docs/prd.md` — the product and its metrics
3. `docs/architecture/architecture.md` + `docs/architecture/data-models.ts` — the laws and the schema
4. `docs/design/design-system.md` — if touching GUI
5. `docs/dependencies.md` — before adding ANY dependency
6. `docs/internal/roadmap.md` → the active phase file → `docs/internal/progress.md` + `docs/internal/decisions.md`

Then check `.agents/skills/` and read every SKILL.md relevant to the task at hand **before writing code**. They encode environment-specific traps (readback alignment, TSL-only materials, prune/dedup breakage, dither flicker, golden tolerances) that will cost hours if rediscovered.

## Invariants (the laws — do not weaken to ship a feature)

1. **Manifest is the only interface.** Every capability is a CLI verb over manifests. The GUI is a projection; if a screen needs something the CLI lacks, the capability moves to core first. (D-002, D-003)
2. **Preview/export parity.** One render core produces both previews and bakes. Extended to animation: **retarget once, in core** — the GUI plays core-retargeted clips, never its own. (D-006)
3. **Cache hashes inputs, never output pixels.** Keys include `rendererVersion` and bind to `characterId` (immutable slug), never `displayName`. (D-011)
4. **Everything becomes canonical glTF at the importer border.** Downstream speaks one format. (D-012)
5. **AI backends and animation packs are catalog data**, not hardcoded integrations: license, territory, VRAM, and `paramsSchema` live in the registry; gates are enforced before install/run. (D-009)
6. **`BakeManifest` is canonical; exporters are pure projections.** AOV atlas pages are rect-identical to the lit page. (D-010)
7. **Every GUI mutation is a journaled, reversible manifest patch** (undo/redo is core, not a GUI trick).
8. **Determinism:** same inputs on the same machine → identical bytes. Fixed seeds recorded as provenance. Cross-machine pixel equality is NOT assumed anywhere.

## Working agreements

- **Commits:** Conventional Commits (`feat(render): …`, `fix(importer): …`). Reference roadmap task IDs (`P2-T1`) in commit bodies and PRs.
- **Tests:** new code lands with tests; target 80–100% coverage on `packages/*` logic. Renderer work uses the two-class assertion model in the `renderer-golden-testing` skill (structural asserts first, tolerant goldens second). Golden changes are reviewed as images with a stated reason. Auto-retry on image suites is forbidden.
- **Docs-sync duty:** if a change makes `docs/` wrong, fixing the doc is part of the change — same PR.
- **Decisions:** anything that binds the future (dependency, format, API shape, invariant exception) gets an append-only entry in `docs/internal/decisions.md` with the next D-number.
- **Dependencies:** check `docs/dependencies.md` first. New deps need a license row there in the same PR. Never bundle anything outside MIT/Apache-2.0/BSD/ISC/OFL/CC0. FBX goes through ufbx — never FBX2glTF binaries (Autodesk SDK).
- **Session hygiene:** update `docs/internal/progress.md` at session end — what moved, what's blocked, what's next.
- **Scope:** work the active roadmap task. Adjacent improvements become roadmap notes, not drive-by changes.

## Copy & UX rules (when touching anything user-facing)

Sentence case; verbs name outcomes ("Generate model", "Save canonical mesh"). Every primary action shows its CLI twin. Errors are honest and retryable-aware; the log drawer renders the NDJSON stream verbatim. Canvas wells stay dark in both themes. Nearest-neighbor at integer zoom for any pixel-truth surface.

## Skills index

| Skill | Reach for it when |
|---|---|
| `webgpu-headless-rendering` | any code creating a GPUDevice, rendering offscreen, or reading pixels back in Deno |
| `threejs-editor-viewport` | any GUI 3D viewport: renderer choice, controls, gizmos, picking, disposal |
| `gltf-pipeline-processing` | any code touching model files: import, transforms, skins, deterministic writes |
| `npr-sprite-stylization` | the style stack: quantize, dither, outlines, temporal stability, flicker debugging |
| `renderer-golden-testing` | writing/fixing image tests, golden updates, CI-without-GPU strategy |

Planned (authored at p3 start): `animation-retargeting`, `sidecar-vram`.
