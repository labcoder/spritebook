# P0-T4 — Mesh2Motion as a retarget harness for externally rigged models

**Verdict: YES — usable.** Mesh2Motion has a dedicated, separate retarget page ("Use Your
Rigged Model") that imports an externally rigged model with its skin/armature preserved, maps
its bones to a Mesh2Motion source skeleton, and exports the model with retargeted clips as one
GLB. It is labeled **Experimental** in the UI. The *main* rigging flow, by contrast, discards
external rigs entirely — so use the retarget page, not the main flow, for UniRig outputs.

Evidence gathered 2026-07-11 against repo `scottpetrovic/mesh2motion-app` @
`626d41d4d4670cdb4a788154762effe0a108ac24` and the live app.

## Where

- Live: **https://app.mesh2motion.org/retarget/** (nav: "Use Your Rigged Model"; page title
  "Retarget - Mesh2Motion", heading "Bring your own rigged model", badge "Experimental").
  Note: WebFetch/curl get HTTP 403 (bot protection); loads fine in a real browser.
- Source: `src/retarget/` (own Vite entry → `dist/retarget/index.html`). Solver in
  `src/retarget/human-retargeting/Retargeter.ts` (chain-based with rest-pose handling +
  twist/axis additives — not a naive rotation copy).
- Self-hosting is trivial if the hosted page changes: `npm install && npm run dev` (MIT).

## Code evidence (why external rigs work here and not in the main flow)

- Main flow strips rigs: `ModelCleanupUtility.strip_out_all_unecessary_model_data()` rebuilds
  every `SkinnedMesh` as a plain `Mesh` (geometry+material only) — imported models are
  re-rigged from scratch with M2M's own skeletons.
- Retarget flow preserves rigs: `StepLoadTargetModel.handle_file_select()` calls
  `set_preserve_skinned_mesh(true)`; `StepLoadModel.process_loaded_scene()` then keeps the
  scene intact ("for now, just keep everything") and dispatches `modelLoadedForRetargeting`.
- Validation: rejects files without a `SkinnedMesh` — modal "No SkinnedMesh found in model
  file for retargeting". **Armature-only files are not accepted; the mesh must be skinned.**
- Mapping: `StepBoneMapping` + `BoneAutoMapper` (name normalization, side/category
  classification, plus dedicated `MixamoMapper` and `RigifyMapper`). If target bone names are
  *identical* to the M2M rig, mapping is skipped automatically
  (`are_source_and_target_bones_identical`).
- Export: `StepExportRetargetedAnimations` → three.js `GLTFExporter`
  (`binary: true, onlyVisible: false, embedImages: true`) exporting the **target scene
  (skinned mesh + skeleton) with the selected retargeted clips** — i.e. exactly the
  `rigged.glb` input `spikes/autorig/render/contact-sheet.py` expects.

## Workflow for the spike (UniRig output → animated glb)

1. Have the UniRig-rigged model as **GLB with a skinned mesh** (FBX/ZIP also accepted; GLB
   preferred — FBX imports at cm scale and has a known Mixamo hips-hierarchy quirk noted in
   the code). Scale: 1 unit = 1 m; models > 20 units trigger a warning and auto-rescale.
2. Open https://app.mesh2motion.org/retarget/.
3. Source skeleton: keep **Human** (auto-loaded; dropdown also has fox/bird/dragon/kaiju/
   spider/snake/fish for Track B later). Its 66 bones are the same convention as our
   downloaded clip libraries (`root, pelvis, spine_01..03, clavicle_l, upperarm_l, ...` — see
   `NOTES.md`).
4. "Upload Rig" → pick the rigged glb. The **first** SkinnedMesh's skeleton is used for
   mapping (single-character files only; one skeleton per file for Mixamo rigs).
5. Bone mapping: click **Auto-Map** (handles Mixamo and Rigify names out of the box; M2M-named
   rigs skip this step entirely). Fix leftovers by hand (drag source bone onto target slot);
   ≥ 1 mapping enables Continue. A live preview plays while mapping.
   - Synergy worth testing: UniRig ships a Mixamo skeleton config
     (`spikes/autorig/UniRig/configs/skeleton/mixamo.yaml`) — emitting Mixamo-convention names
     from UniRig should make Auto-Map (✨Mixamo badge on the upload panel) do all the work.
6. Continue → animation list (filter box; e.g. `Walk`, `Jog`, `Sprint`, `Idle_A`) → select
   clips → **Download**. Output = one binary GLB: your mesh + your skeleton + retargeted clips.
7. Feed that GLB to `spikes/autorig/render/contact-sheet.py` and inspect shoulders/hips.

## Caveats

- **Experimental** label is the app's own; expect rough edges. If it breaks on a UniRig rig,
  fallbacks (in order): three.js `SkeletonUtils.retargetClip` harness (MIT, already a BOM
  reference for our own retargeter), or a bpy name-mapped retarget script. Per the task
  condition ("only if M2M supports nothing but its own flow"), no bpy retarget script was
  written — the M2M harness exists and is the ratified spike path.
- **Clip source is M2M's bundled CC0 library only** (loaded from `/animations/<type>` per
  skeleton type; the retarget page has no custom-clip upload — `CustomAnimationImporter`
  exists only in the main flow, and validates against M2M's own skeleton anyway). The P0-T4
  roadmap wording says "apply one UAL clip"; via this harness the clip will be a Mesh2Motion
  CC0 clip instead (same license posture, same purpose — deformation inspection). If a
  literal Quaternius UAL clip is required, that retarget goes through our own tooling instead.
- Retargeting quality: humanoid chain solver with rest-pose compensation; proportions are
  handled, but hand/finger fidelity depends on how many of the 66 source bones actually map
  onto the UniRig skeleton (UniRig AR skeletons are usually much sparser — unmapped source
  bones are simply dropped).
