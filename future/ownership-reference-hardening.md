# Ownership references and authored appearance: hardening trial

2026-10-23, F5-T2/F6-T1 and the approved first-character milestone, step 4. This extends
[the binding follow-up](binding-clothing-followup.md). **No new repair or appearance candidate
qualifies for automatic use.** These experiments produce an explicit refusal, rather than treating
fewer missing anchors or a lower average strain as success.

All scripts, exact input/output hashes, bounded-worker logs, arrays and diagnostic images are in the
private `.render-bench/ownership-reference-hardening-2026-10-23/` directory. No live character,
production module, source topology, provider, dependency or accepted rig was changed. The tests are
CPU-only while the separate generator cohort uses the GPU.

## Complete references do not by themselves establish correct ownership

The retained Amy source has 595,107 render vertices, 799,985 triangles and 28 predicted joints. The
previous guided same-surface fill left seven selected body components, containing 3,268 welded
positions, without trustworthy body anchors. Multi-view source diagnostics localize these to
hip-level jacket/cuff fragments and tiny shaded patches; their source colors and proximity do not
certify which moving part owns them.

A diagnostic authoring hypothesis explicitly attaches those fragments to the pelvis instead of
silently finding the nearest bone. A second hypothesis assigns one reviewed shaded hand fragment to
`hand_r`, retaining the other explicit references. Both start from the prior reviewed candidate.
Neither is claimed to be anatomical ground truth. This tests the tempting shortcut of supplying a
plausible complete reference to eliminate the missing-anchor report.

The candidate GLB is serialized and read again. Assertions preserve every source position, normal,
UV, triangle index, embedded image, node transform/hierarchy, joint order and inverse bind. A
separate audit checks material bindings and PBR state; the source hash remains unchanged. Exact
coincident seams retain identical weights and remain coincident at every tested pose.

Seventeen frozen core poses each cover walking, jump start, airborne jump, landing and raised arms.
Every source edge longer than 1.1 micrometres is measured, with no selected-region or upper-length
filter: 1,376,756 unique edges per pose.

| Clip        | Original worst per-frame P99 edge/rest | Reviewed explicit references |
| ----------- | -------------------------------------: | ---------------------------: |
| Walk        |                                 2.646× |                       1.351× |
| Jump start  |                                 4.464× |                       2.155× |
| Jump loop   |                                 4.008× |                       1.882× |
| Landing     |                                 3.785× |                       1.917× |
| Raised arms |                                 5.635× |                       1.750× |

Those numbers hide a worse tail. Worst P99.9 rises from 11.84× to 55.12×; maximum stretch rises from
42.91× to 1,047.19×. One retained 0.476 mm source edge becomes 498.3 mm long. Front/side
whole-character diagnostic views still show jacket wings and stretched transition surfaces. **Reject
both hypotheses.** An explicit reference can be wrong; resolving every missing-anchor entry is not
an acceptance criterion.

The reviewed selection has 1,574 triangles connecting different body/hand-cuff owners. This count
includes legitimate garment transitions and uncertain contacts. It does not authorize deleting those
faces or prove that every one is a fusion. A repair needs reviewed part boundaries and appropriate
transition weights, or a deliberately authored topology change with its own texture, boundary and
motion checks. Another unrestricted weight fill is not justified by this trial.

## Independent controls remain useful

The unchanged known-region harmonic helper is replayed into the new directory. Two independently
connected sheets 1 mm apart retain separation, a corrupt patch recovers within 3.115e-7 weight
error, cross-owner bridges are reported, and conflicting coincident owners or anchorless surfaces
refuse. These checks do not use geometric proximity to add connections.

On the bundled CC0 authored female, clean constrained weights change motion by less than 0.00009 mm
over the existing 65-sample walk/jump controls. Deliberately corrupted thigh weights produce
0.724–1.111 m errors; known-region repair reduces these to 8.98–12.39 mm. An additional 17-sample
replay of all five motions, including raised arms, passes the same improvement bound. This
demonstrates recovery from controlled damage with known owners, not reconstruction of arbitrary
generated skinning. Exact authored motion is not recovered.

## An authored surface with transferred appearance is a different experiment

The separate candidate retains the actual bundled CC0 body surface: 8,844 vertices, 15,060
triangles, 65 authored joints and its original weights, UVs and inverse binds. The generated Amy
surface is not the deforming mesh. This is not another nearest-donor weight transfer.

First, the existing `fitCanonicalBody` is run against the complete Amy target under a 180-second,
2-GiB worker bound. It produces no completed candidate before the timeout. Observed peak working set
is about 400 MiB. This is a bounded performance failure during concurrent work, not a minimum
hardware requirement or proof that every fit will time out.

The separate appearance-only trial therefore preserves the authored body geometry explicitly. Its
cut-out front reference is painted using the existing CPU `reprojectTexture` capability. The direct
call exposes a capability limitation: the function uses the first textured primitive and first
material. On this multi-material body those are eyebrows, not the main body. It paints 191 of
262,144 atlas texels and cannot establish whole-body appearance transfer.

A private projection input selects the main body primitive/material deliberately, then transfers
only the resulting image back onto the intact authored character. Assertions verify that all its
geometry, authored skin, hierarchy and inverse binds survive unchanged. This paints 46,426 of
262,144 texels at 512px, including 9,631 seam-dilation texels: 17.7% atlas coverage. Occluded/back
regions and other materials retain their authored fallback. Coverage is an atlas statistic, not a
percentage of recovered visual identity.

All 85 motion samples complete with finite deformation and coincident exact seams. Worst P99
edge/rest is 1.423× walking, 1.590× jump start, 1.306× airborne, 1.596× landing and 1.000× raised
arms. These are diagnostics, not universal quality thresholds. Flat triangle contact sheets make the
tradeoff plain: the authored surface retains its controlled limbs and fingers, but its head, hair,
glasses, jacket volume, trousers and overall proportions do not become Amy. Front-only projection
produces visibly misplaced appearance.

Height-normalized rest silhouette overlap is 0.524 front and 0.430 side. These include rest-pose
differences and are not pose-independent identity scores. **Reject the candidate as an Amy
replacement.** A dependable authored-body option needs compatible body/garment shapes and an
appearance-transfer contract, with explicit identity approval; simply repainting a generic body does
not supply those.

## What these results require of the product

- Keep a known-good authored import/reference path available without model downloads. It proves the
  capture/export flow without implying that generated surfaces are animation ready.
- Keep motion and likeness as separate review decisions. A lower P99 or a successful solver exit
  cannot approve either one. Preserve the source and compare candidates before replacing it.
- A guided repair must show ambiguous surfaces and the proposed ownership/reference. It must retain
  a refusal when that reference is not trustworthy, even if every vertex has a weight.
- Establish one prepared authored garment/body example before promising automatic clothing
  correction. Generation, selected source boundaries, collider coverage and appearance transfer are
  separate contracts.
- Before a multi-material authored appearance path ships, remove the implicit first-primitive/
  first-material assumption and qualify pose/proportion matching. Do not silently bypass those
  limits with nearest-surface projection.

These conclusions come from local source and executable artifacts, including
[`fit.ts`](../packages/rig/fit.ts), [`reproject.ts`](../packages/gen/reproject.ts),
[`identity.ts`](../packages/gen/identity.ts) and the
[CC0 body manifest](../packages/rig/bodies/ubc-female/body.json). The original authored asset is
from
[Quaternius Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html).

No shared-core shaded render, continuous collision certification, new generator inference,
additional native platform or weaker hardware was qualified in this CPU-only subtrial. CPU
vertex/flat-triangle images are explicitly diagnostic projections, not claims of preview/export
parity. All owned workers have completed or been terminated at their recorded bound.
