# The close-out experiments: B3 lighting frame, C1 steps, C3 textureSize, C4 preprocessing

**Status: RUBRIC — committed before any rendering.** Results land below the line.

## B3: `lightFrame: 'world' | 'camera'`

The light is world-locked today, so back-facing directions are lit from behind and read dark —
shipped 3D-to-sprite practice (Dead Cells, impostors) keeps the light WITH the camera so all
directions read identically. The option rotates the key light by each direction camera's yaw;
ambient is unchanged; within a direction the light is still constant per clip, so the temporal
stability law holds.

- **Render:** all three subjects × both options × all 8 directions (one frame each), clean style.
- **Metrics:** mean V per direction row for both options (the spread across directions is the number
  'camera' exists to shrink); everything else is the sheets.
- **Decision:** pick the default from the sheets. If 'camera' wins, it must show no new artefact (a
  rim that flips sides between directions is the known risk); if 'world' stays, the close report
  names back-row darkness as a shipped residual. Either way the loser remains available behind the
  flag, and the cache key carries the choice (lightRigHash gains lightFrame).

## C1: steps 12 / 20 / 35 at the frozen tier + guidance (512, 3.5/0.2)

- Grid: steps ∈ {12, 20, 35} × subjects {bulma, mermaid} × seeds {7, 100} = 12 gens.
- Metrics: the A1 colour set (hueDist/chromaDelta), wallSeconds, and the RENDERS — steps is a shape
  knob, so hands/hair-strand detail on the clean render is the judged surface.
- Decision: the default moves off 12 only for a visible shape improvement in the renders or a ≥ 20%
  hue improvement, at a cost the candidates flow can absorb; ties go to 12 (cheapest).

## C3: textureSize 2048 vs 4096 (the 30-minute check)

- Grid: {2048, 4096} × bulma × seeds {7, 100} = 4 gens.
- Metrics: receipt textureRes, texture-space hueDist, and a 128 px clean render pair.
- Expectation stated up front: NULL at sprite scales — textureSize is the export-side bake
  resolution. A null keeps 2048 and closes the question.

## C4: preprocessing A/B pin

The documented-safe chain is: our pre-cut RGBA + `preprocess_image=True` (rembg only fires when
alpha is absent). Pin it with one A/B: bulma pre-cut vs the SAME image flattened onto white (no
alpha, so the pipeline's own BiRefNet path would run — which our adapter deliberately stubs, so the
flattened variant documents what the refusal protects against).

- Grid: {pre-cut RGBA, white-flattened RGB} × seed 7 = 2 gens (the flattened one may refuse — a
  refusal IS the expected pin).
- Decision: none — this is a regression pin, recorded so the chain stays deliberate.

## Results land below this line only after the grids are complete.

### B3 result — 'camera' is the default (2026-07-31)

Three subjects (the A3 canonical picks) × both options × 8 genuinely rendered directions
(`--no-mirror`, so no flipped frame could fake a lighting answer), clean style, cell 128. Mean V of
covered pixels per direction, spread = max − min across the row:

| subject  | world spread | camera spread | world mean V | camera mean V |
| -------- | ------------ | ------------- | ------------ | ------------- |
| bulma    | 0.174        | **0.072**     | 0.545        | 0.604         |
| princess | 0.192        | **0.107**     | 0.578        | 0.650         |
| mermaid  | 0.026        | 0.125         | 0.421        | 0.472         |

The sheets: under 'world' the back rows lose the character — bulma's pink shirt and princess's
cream dress read mud at d4–d6. Under 'camera' every facing reads as the same sprite. The
counter-signal was investigated rather than averaged away: mermaid's spread RISES under 'camera'
because her back hair is genuinely the brighter albedo mass — 'world' was cancelling that real
albedo asymmetry against its lighting falloff, which is why her world row's 0.026 was never
evidence of good lighting. 'camera' removes the lighting term from the spread; what remains is the
character. The registered artefact check (a rim that flips sides between directions) does not
appear: the key's screen-relative offset is constant by construction in 'camera' mode.

**Landed:** `DEFAULT_LIGHT_FRAME = 'camera'` (renderer.ts); 'world' stays behind
`bake --light-frame world`; lightRigHash carries the resolved frame, so the modes never share a
cache row. Sheets: scratchpad `b3/lightframe-sheets.png`. Full suite green after the flip — the
committed goldens are front-facing (yaw 0), where the two frames agree exactly.
