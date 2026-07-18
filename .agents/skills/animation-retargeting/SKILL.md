---
name: animation-retargeting
description: Retargeting humanoid animation clips onto arbitrary rigged characters — orientation transfer, bone mapping, root motion, foot grounding, and the validation that catches silent garbage. Use this skill whenever implementing or modifying anything in the animation module - the retarget profile, clip sampling, pack ingestion, preview-clip emission - or whenever retargeted motion looks static, crumpled, reversed ("ostrich knees"), or detached. The core rules here were bought with a full day of P0-T4 debugging in which every visible defect turned out to be OUR retarget bug, not the rig; deviating from them reproduces those bugs exactly.
---

# Humanoid animation retargeting

P0-T4's first evidence round showed near-static upper bodies, crumpled forearms, and backward knees
— and all three were bugs in our retarget harness, not in the auto-rig. The fixed harness
(`spikes/autorig/render/retarget-bpy.py`, reference-only) recovered correct knee hinge (flexion
0.34–0.95 matching source), natural arm swing, and clean shoulders on the same rigs. These rules are
that post-mortem, generalized.

## The transfer law: world orientations only

- **Transfer world-space bone ORIENTATIONS. Never write absolute joint placements, and never rotate
  a bone about its own rest head.** The original harness did both: children detached from the parent
  chain, knees measured ~zero flexion at every frame while the source flexed 0.4–0.97. Heads must
  ride the updated parent chain; only orientations come from the source clip.
- Orientations are proportion-invariant — that is _why_ one clip retargets across a tall, short, and
  chunky body. Anything positional (bone lengths, offsets) belongs to the TARGET skeleton.
- The only translation that transfers is the **hips/root trajectory**, scaled by the leg-length or
  hip-height ratio between source and target. Everything else is rotation.
- **Rest-pose alignment first.** Compute per-bone rest-to-rest deltas between source and target
  skeletons before any frame is sampled; apply source frame orientations THROUGH those deltas.
  Conjugate by the facing yaw — measure it (it was ~0° for the P0-T4 assets; do not assume 0).

## Bone mapping

- Mapping is **name-based over a semantic profile** (the UE-style 66-joint humanoid convention —
  both Quaternius UAL and Mesh2Motion target it, so one profile serves both).
- Generic `bone_N` names break every downstream consumer (Mesh2Motion Auto-Map mapped 12/22 on the
  P0-T4 giant). A semantic-naming pass is mandatory before retargeting auto-rigged skeletons; the
  position-based seed is `spikes/autorig/tools/rename-bones.py` (side-verified, mirror-guarded).
- Position-match naming has a proportion ceiling: giant/chunky proportions exceeded the match
  threshold for arms and feet. Production naming needs per-body-plan profiles, not one threshold.
- **Record left/right side anchors explicitly in the profile.** Side assignment from geometry alone
  is genuinely ambiguous on near-symmetric characters — the P0-T4 mirror detection tied itself to
  float noise until anchored to a reference rig.
- Unmapped bones: leave them at rest, list them in the retarget report. Never guess, never
  hallucinate a limb the target does not have (the asymmetric character adapting to its missing
  forearm is founding-constraint evidence, D-008).

## Root motion and feet

- Hips carry the root motion. Transfer the trajectory (scaled as above); keep it separable so the
  bake can zero it (in-place sprites) or export it (engines that consume root motion).
- **Foot-ground preservation is a correction pass, not an outcome of good transfer.** After
  orientation transfer + hip scaling, measure foot height against the ground plane on contact frames
  and correct (hip drop or leg IK nudge). The P3-T1 acceptance — a UAL walk on three
  different-proportioned humanoids keeps feet planted within tolerance — is the test form of this.
- Texel-grid snapping of root motion happens at the STYLE stage (npr skill), not here; the retarget
  emits continuous motion.

## Retarget-once (D-006)

Core retargets exactly once and emits the retargeted clip as a GLB artifact; previews play that
artifact; the bake samples that artifact. The GUI never retargets. Parity is provable and proven:
per sampled frame, joint angles in the preview GLB must equal what the bake renders (the P3-T1
parity acceptance). If preview and bake can disagree, the architecture is already wrong.

## Symmetric clips, asymmetric rigs

Human-symmetric clips visually break on asymmetric bodies — expected, not a defect (P0-T4 asymmetric
verdict). The answers are per-character clip curation (`ClipBinding.enabled`), tier-2 repair verbs,
and D-008's opt-in mirroring. Retargeting must degrade honestly: map what exists, report what does
not.

## Validation: numbers first, eyeballs second

- **Never trust "it ran" or visual vibes alone.** The P0-T4 defect was invisible in stills and
  subtle in motion; the diagnosis came from MEASURED joint flexion (source vs result, per frame).
  Every retarget implementation ships with numeric checks: hinge-joint flexion ranges vs source,
  foot-height-at-contact tolerance, hips trajectory continuity, quaternion continuity (no sign flips
  between frames).
- Contact sheets are the human-review format: columns = evenly spaced clip frames; row 1 = full
  figure 3/4 view; rows 2–3 = fixed close-up crops on the trouble joints (shoulders, pelvis).
- When a retarget looks wrong, suspect the harness before the rig — that is the P0-T4 lesson in one
  line.
