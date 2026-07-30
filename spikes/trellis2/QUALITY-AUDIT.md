# Quality audit: why the sheets look worse than the pipeline is

**Date:** 2026-07-30 · Status: REVIEWED — adversarial agent, two blockers found and folded in

The maintainer's complaint, taken seriously: outputs should read as _crisp snapshots of the 3D model
rotated in space_, and bulma's colours (teal hair, blue skirt, pink top) do not match the reference.
A prototype using TripoSplat gaussians looked better; meshy.ai and tripo3d look good on the first
try. Is the architecture wrong?

## Verdict up front

**The architecture is sound. The quality is losable at five specific points, four of which are
defaults rather than design.** The stage seams (image → mesh → rig → render → style → pack), the
catalog-as-data backend registry, receipts, and the deterministic CPU style stage are all pulling
their weight — nothing below requires moving a boundary. What the audit found instead is a pipeline
whose every default was tuned for _safety and speed during bring-up_ and never re-tuned for _first
impressions_, plus two quality stages that exist in the codebase and are not in the default path.

## The decomposition, proven with one image

`out/p3-exit/contact/audit-quality-decomposed.png` — four panels, same mesh, same rig:

| panel     | what it is                                                                    | what it shows                                                                    |
| --------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| reference | the input image                                                               | —                                                                                |
| pixel     | the shipped default: 64 px, 16 colours, outline                               | what the maintainer has been judging                                             |
| clean     | **existing flags only**: `--style painterly --colors 256 --cell 128 --ppm 64` | the model itself is far better than the default presentation                     |
| xfer      | clean + a 40-line Oklab colour transfer from the reference                    | pink top, blue skirt, teal-leaning hair — most of the colour gap closes globally |

Measured: the generated sprite's mean Oklab L is **0.390 against the reference's 0.708** — the
character is painted at roughly half the reference's lightness before any style stage touches it.
The transfer closes that and most of the hue drift in one deterministic pass.

So the "low quality" impression decomposes into:

1. **Presentation** (~half of it): 64 px cells + 16-colour quantization + dark outline is a heavy
   NPR treatment applied by default, and it is what every review image showed.
2. **Colour fidelity** (~the other half): the TRELLIS.2 texture is hue-shifted and dark, and nothing
   in the default path reconciles it with the source image.
3. A residue (face softness, hair leaning green) that needs texture-stage work, not styling.

## The quality ledger — where fidelity is currently lost

### L1. The generation texture sampler runs with CFG OFF (the largest single defect)

`operationDefaults.gen3d` sets `guidanceStrength` (shape) but **not `textureGuidance`**, so every
`gen` textures at the adapter's internal default 1.0 — which the CFG mixin short-circuits to _no
guidance at all_. The retexture path was swept (GUIDANCE-REPORT.md: 7.5 closed 71% of the saturation
gap at zero cost) and its default fixed; gen never got the same sweep. bulma-fixed's receipt
confirms: no `textureGuidance` in params. **The character everyone has been evaluating was textured
by an unguided sampler.**

Upstream corroborates both the defect and the fix, and CORRECTS our expected value. This is a known
TRELLIS.2 weakness (issues #43 "Color difference is large compared to reference image" and #162,
both unanswered), and production deployments do not run at 1.0 OR at our retexture 7.5: Scenario
ships texture guidance **2** and calls it "critical for color accuracy"; fal warns higher values go
"vivid but potentially oversaturated"; the best-quality recipe in issue #92 uses 2.5 with
`guidance_rescale` 0.2. Our adapter does not even EXPOSE the texture stage's `guidance_rescale` (we
pass strength only; upstream ships 0.0). So the sweep is not "confirm 7.5" — it is a 2-axis sweep
(strength 1.0/2.0/3.5/7.5 x rescale 0.0/0.2) that will likely land near 2-3, and our retexture
default of 7.5 gets RE-judged by the same grid, for hue accuracy against the source and not just
saturation recovery (the original sweep's metric).

### L2. No colour reconciliation with the source, despite two mechanisms existing

- `pick --reproject` (reproject.ts) projects the source image onto the front of the mesh — built,
  tested, opt-in, never in the default path.
- Nothing does _global_ colour matching. The measured L/hue gap is exactly the kind of thing
  Reinhard/histogram transfer in Oklab fixes deterministically, in texture space, benefiting all 8
  directions — and it is backend-agnostic, which reprojection (front-view assumption) is not.

### L3. The whole model ran in its smallest configuration

bulma-fixed: `pipelineType 512, steps 12, lowVram true` → **3.0 GiB peak on a 24 GiB card**.

- **Upstream's own shipped default is `1024_cascade`** — both `pipeline.json`
  (`default_pipeline_type`) and the official demo (its "1024" radio maps to `1024_cascade`). And the
  tier is not shape-only: at `"512"` the TEXTURE flow model also runs at 512 instead of 1024. We are
  two configuration notches below the authors' own default on both shape AND texture.
- `steps 12` is upstream's pipeline.json default, but production deployments run 20 (Scenario, all
  stages) and the demo slider goes to 50; 20-35 is untested here.
- The 512-over-1024 tier decision is documented and evidence-based (fewer collapses, better texture)
  — **but that evidence was gathered at texture guidance 1.0, with a 512 texture model judged
  against a 1024 one that had no guidance either**. With guidance fixed, the tier comparison must be
  re-run; the earlier conclusion may not survive, and upstream's default disagreeing with ours
  raises the re-test from nice-to-have to obligatory.
- Plain `1024` (non-cascade) was never tested at all.
- `lowVram` — MEASURED during this audit rather than assumed: `false` loads slower (122 s vs 87 s —
  everything moves to GPU up front), runs faster (15.5 s vs 21.8 s), peaks at 16.5 GiB vs 3.0. For a
  one-shot gen it is a net LOSS (137 s vs 109 s end to end), and a 16 GiB card cannot afford it at
  all. It only pays inside a session that keeps the model loaded across many samples — which is the
  candidates mode below, where the 87 s load already amortizes. Conclusion: keep `lowVram: true`
  everywhere; the "adaptive lowVram" idea is dropped by its own measurement.

### L4. One seed, one die roll

Bodies vary by seed (astro: 2 at seed 7, 1 at seeds 100/201); texture collapse is ~5% per seed;
colour fidelity varies. Closed services feel "always good on the first try" because they are NOT
showing you their first try — documented product behaviour, not speculation: Meshy's own tutorial
returns **four draft models** per request and lets the user refine one ("if none are satisfactory,
Regenerate"), with draft retries effectively free; Tripo stages a 2–5 s draft before the expensive
refine. The fan-out is a PRODUCT-layer mechanism sitting on an ordinary model. The pipeline here
already records every quality signal needed to pre-rank candidates — `bodies`, collapse detection,
metal fraction — and the sidecar loads the model once per job (87 s), so N candidates in one job
cost `87 + N×22` s, not `N×110` s. Upstream makes this even easier than a seed loop: `run()` takes
`num_samples: int = 1` natively.

### L5. Presentation defaults bury the model

`pixel` (64 px, 16 colours, outline) is the identity of the product but the wrong _first_ impression
of a generation. There is no "just show me the model" style: painterly still quantizes to 32
colours, and nothing renders above cell size. A `clean` preset (no quantize, no outline, soft alpha,
supersampled) is ~15 lines and the pipeline already supports every part of it (the
`palette.size === 0` path exists).

### L6. Minor, real, already-known

The lighting rig is one mostly-overhead key + ambient — correct (LIGHTING-REPORT.md) but flat;
`palette-dark` outlines lift with ambient (princess); rig quality (9 flagged joints) is a separate
thread; the fresh-machine UniRig config caveat stands.

## What gaussians were buying, honestly

The TripoSplat prototype rendered _view-conditioned radiance_: splats store colour as spherical
harmonics (view-dependent — sheen and glancing light a baked albedo cannot hold), carry no
UV/bake/decimation loss at all, are supervised by image-space photometric loss (they reproduce what
the picture LOOKED like, baked lighting included), and their alpha falloff is free anti-aliasing on
every silhouette. Tripo's own preference study scores **TripoSplat 1137 Elo against TRELLIS.2's
992** on single-image generation — vendor-run, but it reproduces the maintainer's informal
comparison with numbers. The prototype looking better was real and had causes.

The costs are equally real, and they are why this project chose meshes: there is NO off-the-shelf
rigging or skinning for splats (the research workaround — SplattingAvatar-style binding to a skinned
proxy mesh — reintroduces mesh generation anyway); relighting splats is an open research problem
(illumination is baked into the SH colour); splat silhouettes are semi-transparent halos rather than
clean mattes; and no shipped game or tool renders sprites from splats — there is no practice to
borrow. The animation system is this product.

So the response is not to switch back; it is to steal the two things splats were buying that meshes
CAN have — photometric fidelity to the conditioning image (L1 + L2) and honest presentation (L5).
Splat rendering stays a possible additional backend later (TripoSplat is MIT; the catalog design
permits it), but exploratory only, and it does not gate M3.

---

# The plan (as amended by adversarial review)

Reviewed 2026-07-30 by a fresh-context adversarial agent instructed to verify every claim against
the code. Two blockers and four majors were found; all are folded in below and recorded in "Peer
review" at the end. Naming note: the roadmap calls this milestone **Milestone 2 (P3, beta)** — "M3"
in conversation maps to closing P3.

Three waves close P3. Each lands as small commits with committed measurements.

## Wave A — colour fidelity in texture space, with the lighting term handled honestly

- **A0. Expose `textureGuidanceRescale`** in the adapter + catalog (upstream `guidance_rescale`,
  shipped 0.0; deployments run 0.1–0.3). Touches four surfaces (catalog paramsSchema +
  operationDefaults, adapter schema + pass-through) — both ends are `additionalProperties: false`,
  so the arrival test matters. Retexture gets the same plumbing.
- **A1. ONE combined sweep freezes tier AND texture guidance together** (the review's order fix: the
  512 and 1024 tiers run DIFFERENT texture flow models, so an optimum swept on one is not portable
  to the other). Grid: tier {512, 1024_cascade} × strength {1.0 control, 2.0, 3.5, 7.5} × rescale
  {0.0, 0.2}, 4 seeds, bulma + mermaid, one in-process ladder per tier (~2 h GPU, overnight). Judged
  on HUE accuracy (Oklab a/b distance to source) as well as saturation — the original retexture
  sweep measured only saturation recovery, and deployment practice (Scenario ships texture guidance
  2, "critical for color accuracy"; fal warns higher goes "vivid but potentially oversaturated";
  issue #92's recipe is 2.5/0.2) predicts the optimum near 2–3, not 7.5. `operationDefaults.gen3d`
  AND `retexture` both move (or stay) on this evidence. The judging rubric and seeds are written
  down BEFORE rendering (the seed-42 lesson).
- **A2. `color-match`: hue/chroma transfer in TEXTURE space, with the lighting term compensated.**
  The four-panel demo transferred in image space, post-lighting — its L gain is mostly the rig's
  documented shading term and does NOT survive the move to texture space (review blocker 1). The
  productised pass transfers a/b (hue/chroma) directly and handles L via a shade-compensated target:
  divide the reference's L statistics by the rig's expected mean shade, closed-form from
  LIGHT_DIR/AMBIENT (LIGHTING-REPORT.md). Guard rails, all default-on: chroma-floor auto-skip (a
  near-monochrome source must not crush the texture — unclamped std ratios amplify), std-ratio
  clamp, warn with before/after deltas, `--no-color-match` opt-out. Runs at `pick` time for
  image-sourced characters, BEFORE reprojection (exact source-painted texels must never be shifted),
  one journaled patch, and the matched image's sha is pinned in the patch — closing the existing
  provenance gap where `pick --image` overrides go unrecorded. Oklab becomes an exported shared
  surface (gen cannot import it from style today). Established practice: Reinhard runs unattended at
  industrial scale (stain normalization); Make-A-Character 2 calls colour correction of AI textures
  "essential"; Meshy ships `remove_lighting`, Tripo `textureAlignment: "original_image"`.
- **A3. Measure reproject + color-match together** on all three subjects; `--reproject` joins the
  default for image-sourced characters or stays opt-in, on that evidence.
- **A4 (conditional).** Source-image palette for the pixel path — only if A2's measured residual
  still shows the teal/navy class of miss, and only in shade-compensated form (a raw source
  palette's bright entries go unused against lit renders).

## Wave B — first impressions

- **B1. `clean` style preset** (no quantize, no outline, soft alpha, superSample 4) plus the
  documented recipe `bake --style clean --cell 128 --ppm 64`. No preview verb, no new coupling — the
  GUI viewport (P4) is the real preview; the recipe is the CLI's. The preset gets its own committed
  flicker measurement on 2+ subjects and its OWN budget: the draft's 1.288% reading was n=1 and
  unrecorded, and flicker.ts counts any byte delta — a metric designed for quantized output — so a
  soft-alpha style is not adjudicated against the quantized presets' bars.
- **B2. `gen --candidates N` as an in-process SEED LADDER**, not `num_samples` batching — upstream
  seeds once per batch, which would break the receipt law ("same seed re-runs exactly") and multiply
  activation VRAM. One sidecar job, one model load, N sequential seeds (composes with the existing
  collapse-retry ladder), per-candidate gen-meta and receipts, honest cost ~87 + N×33 s (export +
  border included; N=3 is ~3.2 min). Auto-rank by the recorded signals — bodies, collapse, metal
  fraction, colour distance to source — scored Deno-side after the border, where the importer
  already measures shells. The winner is a SUGGESTION to `pick`; all candidates stay. gen.ts's
  single-artifact event contract grows a per-candidate vocabulary (real, bounded work).
- **B3. Lighting enters scope** (review blocker 2: back-row darkness is per-direction, and no
  texture-space pass can reach it — one texture serves all 8 directions): a minimal
  `lightFrame: 'world' | 'camera'` render option. 'camera' keeps the light fixed relative to each
  direction's view, so all 8 directions read identically — the shipped-game convention (Dead Cells,
  impostor practice). Temporal stability within a clip is preserved (constant per direction); the
  cache is already safe (lightRigHash landed). The default is decided from renders of both on all
  three subjects — a taste call, presented with the back-row brightness measured either way. If
  'world' stays, the close note names back-row darkness as a shipped residual with the artifact
  attached.

## Wave C — remaining headroom (timeboxed, after A freezes defaults)

- **C1.** steps 12 / 20 / 35 at the FROZEN tier + guidance — shape quality (hands, hair strands),
  rubric predefined. Production practice says 20; the demo slider allows 50.
- **C3.** `textureSize` 2048 vs 4096 — a 30-minute check, expected null at sprite scales (it is the
  export-side bake resolution, not texture content).
- **C4.** Preprocessing A/B pin: our pre-cut RGBA + `preprocess_image=True` is the documented-safe
  combination (rembg only fires when alpha is absent); one committed render pair keeps it true.
- The lowVram A/B receipts, inline per the project's receipts standard (out/ is gitignored) — both
  bulma-front, seed 7, tier 512, this machine's RTX 3090:

  | lowVram | loadSeconds | runSeconds | peak reserved GiB |
  | ------- | ----------- | ---------- | ----------------- |
  | true    | 87.49       | 21.80      | 3.01              |
  | false   | 121.93      | 15.47      | 16.53             |

## P3 close criteria (amended)

1. A0–A3 landed; gen and retexture texture defaults frozen on the combined-sweep evidence;
   before/after colour deltas committed for all three subjects.
2. B1 + B2 landed; B3 decided from renders (either default), with the per-direction brightness
   artifact committed.
3. C1/C3/C4 run with predefined rubrics; defaults moved or kept with the evidence stated.
4. `p3_exit.sh` re-run end to end; the fresh-machine UniRig caveat stated in the exit note.
5. The four-panel decomposition REGENERATED with the shipped texture-space pass — the closing
   artifact shows what ships, not the image-space ceiling — plus renders of both lightFrame options.
6. roadmap.md notes that this supersedes P3-EXIT.md's "colour gap belongs to P4".

## Non-goals

Swapping the mesh pipeline for gaussians (TripoSplat stays a possible future backend, exploratory
only); moving stage boundaries; GUI work; `spine_02`-class skinning residue; cel ramps, normal-map
AOV export, and the outline/ambient decoupling — all explicitly P4.

## Peer review record

A fresh-context adversarial agent verified the draft against the code and found: **2 blockers** —
A2's spec contradicted its own image-space demonstration (fixed: hue/chroma in texture space +
shade-compensated L); the close criteria claimed to resolve "dark/muddy" while deferring all
lighting work (fixed: B3 in scope) — **4 majors** — the A1/C2 freeze-order bug (fixed: tier merged
into A1 as a sweep axis); default-on colour match lacked a degenerate-source gate (fixed: chroma
floor + clamp); `num_samples` batching would break receipt reproducibility (fixed: seed ladder);
L1's "largest single defect" ranking was unearned — gen at guidance 1.0 already measured near-source
SATURATION on the one subject measured (GUIDANCE-REPORT.md), so the sweep may land small and A2/B3
carry the complaint — and **6 minors** (unrecorded flicker number; "M3" naming; preview-verb scope
creep; Oklab not actually importable from gen today; the `pick --image` provenance gap; uncommitted
lowVram receipts), all folded in above.
