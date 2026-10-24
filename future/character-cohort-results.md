# Matched character cohort: technical and visual results

Last updated 2026-10-24 03:01 UTC. **Complete: 32/32 baseline and 12/12 supplemental evaluations
recorded; 31 technically complete and 13 failed/incomplete. 44 cases visually reviewed, including
rest-only refusals.** A generation-level `completed.json` is not evidence that rigging, motion or
delivery completed.

## What this experiment can establish

Eight baseline reference images are CC0 procedural variations of two bundled authored bodies:
separated male/female, tall/slim, short/broad, relaxed arms, a separate skirt, loose cuffs and a
one-sided red accessory. They are not eight independent production characters or a representative
user success-rate sample. Input audit found the loose-cuffs and asymmetric-mark ring surfaces
detached beside the body: their eight baseline candidates are INVALID for cuff/asymmetry acceptance
and remain detached-component retention stress cases only. The short-broad input crops both extended
hands at the image edges, so it cannot qualify full-hand retention. Separate frozen supplements
contain correctly attached cuffs, a correctly attached one-sided accessory and a fully framed broad
body (12 additional candidates). This yields five valid baseline designs plus three corrected
controls, 32 valid candidates overall; all 12 flawed-input stress candidates remain retained.
Supplemental outputs do not replace or relabel baseline outputs. Two candidates are generated per
reference for Pixal3D and TRELLIS.2, using their shipping default recipes; model recipe differences
remain a confounder. This is an end-to-end product comparison, not a controlled architecture
ranking.

Each technically complete evaluation records draft UniRig, numeric checks at 17 samples of each of
four motions, core-rendered motion review, two-direction side64 exports and eight-direction iso256
exports. Walk has 12 delivered frames; each jump phase has eight. A successful receipt or an empty
numeric flag list does not approve appearance, clothing or animation.

The visual review compares the original reference and generated rest thumbnail; views four equally
spaced delivered frames per clip in all eight isometric directions, plus every frame of the two
side64 strips. Findings apply to those samples. The figures occupy only part of their 256×320
isometric cells, limiting fine finger inspection. No 4K likeness or continuous collision claim
follows. The shared-core original strips remain authoritative; private nearest-neighbor QA
compositions do not generate or alter model pixels.

## Valid-reference technical totals

Only the eight valid reference designs count toward this table (32 candidates). The 12 flawed-input
stress candidates remain separately visible below and never increase generator qualification totals.
Technical completion means the pipeline produced review/delivery artifacts; it does not mean
visually accepted motion or likeness.

| Model       | Evaluations recorded / planned | Technically complete | Failed/incomplete | Visual reviews recorded |
| ----------- | -----------------------------: | -------------------: | ----------------: | ----------------------: |
| pixal3d     |                        16 / 16 |                   11 |                 5 |                      16 |
| trellis2-4b |                        16 / 16 |                   13 |                 3 |                      16 |

No cohort-wide visual acceptance is assigned. Per-case findings below distinguish sampled sprite
coherence, appearance changes, explicit failures and unqualified details.

## Retained flawed-input stress totals

The separate 12 flawed-input stress candidates finish with 7 technically complete paths and 5
refusals. They do not enter the 32 valid-reference denominator. Both Pixal loose-cuffs seeds and
asymmetric-mark r2 refuse semantic ancestry; the two cropped short-broad Pixal cases also refuse.
Completed detached-component stress paths visibly distort their floating accessories. Cropped
short-broad TRELLIS r2 additionally has a large rear nape/upper-back dark patch.

## What should change next

The controlled valid-reference results do not qualify an automatic dependable first walk/jump. All
32 valid candidates were reviewed: 24 complete technically and 8 refuse downstream. Of those 24
complete paths, the relaxed-arms Pixal seed 0 has a severe moving thigh wing and all 4 skirts
visibly fail clothing coverage. The other 19 have no gross motion failure apparent in these sampled
sprite deliveries, but altered eyes, hands, surface patches or color remain in several cases. This
is sampled coherence, not 19 fully accepted production characters.

1. **Repair semantic mapping first in a separately versioned follow-up.** Six valid candidates fail
   because named bones contradict actual ancestry; two more refuse uncertain upright alignment
   before prediction. Map from supported hierarchy/anatomical evidence, retain honest refusal when
   ambiguous, and replay these frozen failures without replacing their original receipts. The
   separate broad-body orientation opt-out recovers one uncertain case; it does not fix skeleton
   naming.
2. **Keep appearance and motion audition as separate decisions before acceptance.** Extra hands,
   long blade/bar-like hand surfaces, unrequested ground-like surfaces and altered markings are
   visible at rest or in delivered rear views. Body-count metadata and a finite rig do not establish
   source likeness. Preserve the original reference and show all directions, rather than allowing a
   successful export to imply approval.
3. **Treat clothing as a deformation-surface and ownership problem.** Both generators fail the skirt
   control, through different visible shapes. Coincident seams can stay intact while a garment rolls
   or a knee penetrates it. The next repair experiment must identify the entire skirt/body ownership
   and evaluate takeoff/landing as well as walk; nearest donor weights, deleting hidden body pixels
   or lowering motion amplitude alone do not establish a general repair. Any corrective, collision
   or optional Blender result needs the same whole-motion and source-preservation comparison.
4. **Use the clean authored import path as a control and recovery option.** It can distinguish
   generator geometry/appearance defects from downstream binding and retargeting. A
   topology-changing authored-template appearance transfer remains an explicit alternative requiring
   silhouette/identity approval; the separate ownership experiment rejected its current identity
   loss. No new binder/provider is justified merely by these receipts.

Complete the failed-case repairs and clothing experiments before promoting a broad quality promise.
Retain small-sprite previews as an early filter, then check detailed core motion at the intended
export resolution; this cohort does not approve 4K anatomy, arbitrary coats or continuous collision.

## Per-candidate findings

| Design / input validity                    | Model / result / effective seed | Technical receipt    | Visual finding                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| attached-asymmetry (valid reference)       | pixal3d / r1 / 0                | Complete             | No gross motion failure seen at delivered scale; one-sided band retained: Body/two-piece and single band retained on the source side, but red becomes vivid magenta; skin is darker/warmer and reddish hand marks appear beyond the band.                                                                                                                                                  |
| attached-asymmetry (valid reference)       | pixal3d / r2 / 1000             | Complete             | Motion coherent at delivered scale; rear-leg appearance needs repair: Body/two-piece and single source-side band retained, but the red band becomes vivid magenta. Rear/side legs show conspicuous speckled/striped surface patterns absent from the reference.                                                                                                                            |
| attached-asymmetry (valid reference)       | trellis2-4b / r1 / 0            | Complete             | No gross motion failure seen at delivered scale; one-sided band retained: Single red band remains on the source arm and body shape is recognizable. Eyes are much darker and the lower garment is lighter/patchier, especially in rear views, than the dark source two-piece.                                                                                                              |
| attached-asymmetry (valid reference)       | trellis2-4b / r2 / 1001         | Complete             | No gross motion failure seen at delivered scale; one-sided band retained: Body/two-piece and single red band retained with darker graphic eyes and altered body shading. Requested seed 1000 was retried at effective 1001 after material rejection.                                                                                                                                       |
| attached-cuffs (valid reference)           | pixal3d / r1 / 0                | Complete             | No gross motion failure seen at delivered scale; cuffs retained: Both attached green cuffs and the muscular body/dark shorts remain recognizable. Skin and cuffs are more saturated, eyes brighter and hands simplified relative to reference.                                                                                                                                             |
| attached-cuffs (valid reference)           | pixal3d / r2 / 1000             | Complete             | No gross motion failure seen at delivered scale; cuffs retained: Both green bands, body plan and shorts retained; skin is less red than seed 0, but bright eyes, simplified hands and local dark limb marks differ from reference.                                                                                                                                                         |
| attached-cuffs (valid reference)           | trellis2-4b / r1 / 0            | Complete             | No gross motion failure seen at delivered scale; cuffs retained: Both bright green forearm bands and body/shorts retained. Skin is warmer, eyes conspicuously bright and hands simplified relative to reference.                                                                                                                                                                           |
| attached-cuffs (valid reference)           | trellis2-4b / r2 / 1001         | Complete             | No gross motion failure seen at delivered scale; cuffs retained: Both saturated green bands and body/shorts retained, with brighter eyes and warmer skin. Requested 1000 was retried at effective 1001 after a material rejection.                                                                                                                                                         |
| asymmetric-mark (flawed-input stress only) | pixal3d / r1 / 0                | Complete             | Technically complete; detached accessory motion rejected; invalid asymmetry input: Source has one detached red cylinder beside a hip, not an attached one-sided arm band. Rest retains a red detached object, with much darker/warmer skin and altered face than reference.                                                                                                                |
| asymmetric-mark (flawed-input stress only) | pixal3d / r2 / 1000             | Failed or incomplete | Failed technical evaluation: semantic hierarchy refused; invalid asymmetry input: Rest retains a detached red hip-height object and adds another red patch/component below the source-side extended forearm. Original reference contains only one detached cylinder; generated skin/face shading also differs.                                                                             |
| asymmetric-mark (flawed-input stress only) | trellis2-4b / r1 / 0            | Complete             | Technically complete; detached accessory motion rejected; invalid asymmetry input: Detached red hip-height cylinder retained at rest; body remains recognizable but has graphic dark eyes and conspicuous speckled dark garment/body shading. The source object is not an attached arm band.                                                                                               |
| asymmetric-mark (flawed-input stress only) | trellis2-4b / r2 / 1001         | Complete             | Technically complete; detached accessory motion rejected; invalid asymmetry input: Detached red object remains at rest with changed eyes/face and brighter skin shading. Effective 1001 follows the bounded material retry of requested 1000; this is still detached-input stress.                                                                                                         |
| female-separated (valid reference)         | pixal3d / r1 / 0                | Complete             | No gross motion failure seen at delivered scale: Reference body plan and dark two-piece retained, but skin is redder and a conspicuous dark nape/neck patch appears from rear directions. Hand and face detail remain simplified.                                                                                                                                                          |
| female-separated (valid reference)         | pixal3d / r2 / 1000             | Complete             | No gross motion failure seen at delivered scale: Reference build and two-piece remain recognizable; warmer brown appearance and simplified eyes/hands differ. The prominent dark nape patch of seed 0 is not apparent here.                                                                                                                                                                |
| female-separated (valid reference)         | trellis2-4b / r1 / 0            | Complete             | No gross motion failure seen at delivered scale: Reference body plan and dark two-piece retained. Eye region is much darker and more graphic, with simplified fingers and altered muscle shading.                                                                                                                                                                                          |
| female-separated (valid reference)         | trellis2-4b / r2 / 1001         | Complete             | No gross motion failure seen at delivered scale: Recognizable body/two-piece, but dark eye markings and reddish wrist/shoulder/foot patches are conspicuous compared with the reference; requires appearance approval.                                                                                                                                                                     |
| loose-cuffs (flawed-input stress only)     | pixal3d / r1 / 0                | Failed or incomplete | Failed technical evaluation: semantic hierarchy refused; invalid cuff input: The source has two detached green cones beside the hips, not forearm cuffs. Generated rest retains those objects and adds two dark green cuff-like shapes below the extended forearms, for an apparent duplication absent from the source; body skin is redder.                                               |
| loose-cuffs (flawed-input stress only)     | pixal3d / r2 / 1000             | Failed or incomplete | Failed technical evaluation: semantic hierarchy refused; invalid cuff input: Detached hip-height source cones are retained, while an additional bright green pair appears below the extended forearms. This repeats the apparent duplicate component placement of seed 0, with brighter bands and altered skin/eyes.                                                                       |
| loose-cuffs (flawed-input stress only)     | trellis2-4b / r1 / 0            | Complete             | Technically complete; detached-component stress motion rejected: Two detached green hip-height cones remain in generated rest, with brighter green and warmer body shading. They are not attached cuffs in the input and cannot qualify sleeve behavior.                                                                                                                                   |
| loose-cuffs (flawed-input stress only)     | trellis2-4b / r2 / 1000         | Complete             | Technically complete; detached-component stress motion rejected: Rest retains two detached green cones beside the hips. Green is brighter, eyes much paler and body shading warmer than reference. The input is invalid as a forearm-cuff control.                                                                                                                                         |
| male-separated (valid reference)           | pixal3d / r1 / 0                | Complete             | No gross motion failure seen at delivered scale: Recognizable reference build, shorts and separated arms; substantially redder/oranger appearance than reference and the other candidate.                                                                                                                                                                                                  |
| male-separated (valid reference)           | pixal3d / r2 / 1000             | Complete             | No gross motion failure seen at delivered scale: Recognizable reference build and shorts; less red than seed 0, though muscle/hand detail and eye appearance differ from authored reference.                                                                                                                                                                                               |
| male-separated (valid reference)           | trellis2-4b / r1 / 0            | Complete             | No gross motion failure seen at delivered scale: Recognizable build/shorts with warmer skin and more prominent bright eyes; rest hands have a simplified fork-like silhouette.                                                                                                                                                                                                             |
| male-separated (valid reference)           | trellis2-4b / r2 / 1001         | Complete             | No gross motion failure seen at delivered scale: Recognizable build and dark shorts, but white/bright eye patches and faceted muscle/hand forms differ from reference. Rest hand shape is simplified.                                                                                                                                                                                      |
| relaxed-arms (valid reference)             | pixal3d / r1 / 0                | Complete             | Technically complete; visual motion rejected: Relaxed-arm body/two-piece recognizable, but skin is much redder and local hand/face forms differ. Rest thumbnail alone hides the important deformation problem.                                                                                                                                                                             |
| relaxed-arms (valid reference)             | pixal3d / r2 / 1000             | Failed or incomplete | Failed technical evaluation; rest appearance/topology rejected: Body and two-piece recognizable with warmer skin, but two unrequested disconnected extra hands float beside the figure at shoulder/T-pose height while hands are already present near its hips. They are absent from the original reference.                                                                               |
| relaxed-arms (valid reference)             | trellis2-4b / r1 / 0            | Failed or incomplete | Failed technical evaluation: upright refusal; rest appearance rejected: Body/two-piece retained with altered face and red shoulder patches, but a large white ground-like sheet surrounds the lower legs in the generated thumbnail and is absent from the source.                                                                                                                         |
| relaxed-arms (valid reference)             | trellis2-4b / r2 / 1001         | Failed or incomplete | Failed technical evaluation: semantic hierarchy refused: Relaxed-arm body/two-piece recognizable with conspicuous red shoulder patches and altered eye appearance. Effective 1001 follows a rejected requested 1000 material attempt.                                                                                                                                                      |
| short-broad (flawed-input stress only)     | pixal3d / r1 / 0                | Failed or incomplete | Failed technical evaluation; invalid full-hand input: Broad short build and shorts retained, with redder skin and bright eyes. Input and generated rest framing both crop the extended hands, so this is retained only as cropped-input stress.                                                                                                                                            |
| short-broad (flawed-input stress only)     | pixal3d / r2 / 1000             | Failed or incomplete | Failed technical evaluation; invalid full-hand input: Broad short build and dark shorts retained with warmer skin and altered eye/face details. Both the baseline input and generated thumbnail crop extended hands; cropped-input stress only.                                                                                                                                            |
| short-broad (flawed-input stress only)     | trellis2-4b / r1 / 0            | Complete             | No gross motion failure seen at delivered scale; invalid full-hand input: Broad short body/shorts retained, with bright eye-band and altered face. Both source and generated rest thumbnail crop hands, invalidating full-hand retention acceptance.                                                                                                                                       |
| short-broad (flawed-input stress only)     | trellis2-4b / r2 / 1001         | Complete             | Technically complete; rear appearance rejected; invalid full-hand input: Short broad body/shorts and very bright eye shapes retained, but a large black collar-like patch spans upper back/nape in rear and oblique views. Requested 1000 became effective 1001 after a material retry.                                                                                                    |
| skirt (valid reference)                    | pixal3d / r1 / 0                | Complete             | Technically complete; visual clothing motion rejected: Body and skirt retained, but source muted blue becomes saturated cyan and skin redder. Dark speckled regions appear on the skirt in several delivered views.                                                                                                                                                                        |
| skirt (valid reference)                    | pixal3d / r2 / 1000             | Complete             | Technically complete; visual clothing motion rejected: Body and skirt retained, with source blue becoming bright light blue and altered skin shading. Dark speckled skirt regions recur in delivered views.                                                                                                                                                                                |
| skirt (valid reference)                    | trellis2-4b / r1 / 0            | Complete             | Technically complete; visual clothing clipping rejected: Body and skirt are recognizable, but the source muted blue becomes bright saturated blue. The generated skirt has a strongly faceted cone silhouette, with simplified long hands and altered pale eyes.                                                                                                                           |
| skirt (valid reference)                    | trellis2-4b / r2 / 1000         | Complete             | Technically complete; visual clothing clipping rejected: Body/skirt retained, with muted source blue becoming bright cyan-blue, altered eyes and speckled dark top shading. Long simplified hands remain visible.                                                                                                                                                                          |
| tall-slim (valid reference)                | pixal3d / r1 / 0                | Failed or incomplete | Failed technical evaluation; rest appearance rejected: Tall/slim body and shorts retained, but unrequested long gray blade-like sheets beyond both hands are absent in the reference. Skin is also substantially redder.                                                                                                                                                                   |
| tall-slim (valid reference)                | pixal3d / r2 / 1000             | Failed or incomplete | Failed technical evaluation; rest appearance rejected: Tall/slim body and shorts retained, but unrequested long yellow/blue bar-like objects beyond both hands are absent in the reference. Skin is also substantially redder.                                                                                                                                                             |
| tall-slim (valid reference)                | trellis2-4b / r1 / 0            | Complete             | No gross motion failure seen at delivered scale; hand form needs review: Tall/slim body and dark shorts recognizable. Warmer skin, bright white eyes and bar-like simplified outstretched forearms/hands differ from the authored reference.                                                                                                                                               |
| tall-slim (valid reference)                | trellis2-4b / r2 / 1000         | Complete             | No gross motion failure seen at delivered scale; appearance differs: Tall/slim body and shorts recognizable, but a dark scalp-to-nape stripe, bright eye patches and bar-like rest hands differ from reference. This is effective seed 1000 with no material retry.                                                                                                                        |
| framed-broad (valid reference)             | pixal3d / r1 / 0                | Failed or incomplete | Failed technical evaluation; rest framing limits inspection: Fully framed reference's broad/short build and shorts remain recognizable, with warmer skin and an altered eye-band/face appearance. The generated thumbnail crops both extended hands; a separately labeled wider core rest render confirms both hands exist beyond the thumbnail edges, with elongated/merged finger forms. |
| framed-broad (valid reference)             | pixal3d / r2 / 1000             | Failed or incomplete | Failed technical evaluation; rest framing limits inspection: Broad short body/shorts remain recognizable; warmer skin, bright eye-band appearance and small red surface marks differ. The original generated thumbnail clips both extended hands.                                                                                                                                          |
| framed-broad (valid reference)             | trellis2-4b / r1 / 0            | Failed or incomplete | Failed technical evaluation: upright alignment refused: Broad short build/shorts remain recognizable; face and eye appearance differ. Generated rest thumbnail clips the hands despite the fully framed source.                                                                                                                                                                            |
| framed-broad (valid reference)             | trellis2-4b / r2 / 1000         | Complete             | No gross motion failure seen at delivered scale; hands need review: Broad short build/shorts retained, with altered bright eye-band, scalp and face appearance. Rest thumbnail crops extended hands; animation reveals long simplified hand/finger shapes.                                                                                                                                 |

## Detailed visual observations

### attached-asymmetry: pixal3d, r1, effective seed 0

The single colored band follows its arm in all eight sampled directions, swapping image side
appropriately between front/rear. No duplicate opposite-arm band, detached patch or long hand/hip
tether is apparent. One-sided band remains associated with its forearm through all three phases;
shoulders, hands and feet remain connected in inspected samples and complete side64 strips.

Simple one-band asymmetry only, with conspicuous color/appearance drift. This does not qualify
arbitrary asymmetry, accurate digits, high-resolution identity or loose clothing.

### attached-asymmetry: pixal3d, r2, effective seed 1000

Single band follows the correct arm across eight sampled directions and full side64 strips. No large
disconnected fragment or thigh wing appears, but rear-leg patterning persists. Band remains
one-sided during all three phases; torso/limbs stay connected. Speckled leg surfaces remain visible
in rear/side squat and airborne views.

Surface pattern cause is not established from images: material/normal/overlap issues need separate
diagnosis. This is not artifact-free visual acceptance, fine-digit qualification or a general
asymmetry guarantee.

### attached-asymmetry: trellis2-4b, r1, effective seed 0

The band remains single and follows its arm through all sampled directions and full side64 strips;
no visible hip/hand tether or detached lower limb appears. Start, airborne and landing keep
connected torso/limbs and correct one-sided band placement. Local shoulder, elbow and hand contours
remain simplified/angular.

Appearance drift in face/garment needs approval; one accessory does not qualify arbitrary asymmetry
or fine fingers. No high-resolution anatomy or continuous contact claim.

### attached-asymmetry: trellis2-4b, r2, effective seed 1001

Band follows the original arm in eight sampled directions and all side64 frames; no duplicated
opposite-side band, large stretched sheet or missing foot is apparent. All three phases keep the
single band associated with the forearm and preserve connected shoulders/legs. Joint contours and
hands remain angular/simplified.

Sampled simple-asymmetry coherence is not general identity, detailed-digit, high-resolution
deformation or continuous collision qualification.

### attached-cuffs: pixal3d, r1, effective seed 0

Both cuffs follow the forearms in eight sampled isometric directions and both complete side64
strips. No obvious detached green piece, cuff-to-trouser tether or shoulder wing appears. Cuffs
remain near their respective forearms through the three sampled jump phases, squat and raised arms.
Torso, hands and feet stay connected without a large stretched surface.

This is one attached simple band control, not a loose long sleeve or coat. Small-pixel hand shape,
cuff/skin interpenetration and continuous contact require finer inspection; no general clothing
solution is qualified.

### attached-cuffs: pixal3d, r2, effective seed 1000

Both cuffs remain with the forearms across eight sampled directions and all side64 frames. No
visible cuff-to-trouser tether, large arm split or missing foot appears. Both cuffs follow the
raised/swinging arms in start, airborne and landing phases. Shoulders and lower limbs remain
connected at sampled scales.

Simple band control only; no claim about loose sleeve drape, continuous collision, high-resolution
fingers or artifact-free material appearance.

### attached-cuffs: trellis2-4b, r1, effective seed 0

Both bands follow forearms across eight sampled directions and both complete side64 strips; no
obvious detached band, long skin tether or missing foot appears. Bands remain associated with their
arms through start, airborne and landing. Angular shoulder/armpit and thigh contours remain, without
a large wing or split in inspected samples.

Simple rigid-looking band observation, not a long-sleeve cloth pass. Fine digits, cuff/skin contact
and high-resolution joint contours remain unqualified.

### attached-cuffs: trellis2-4b, r2, effective seed 1001

Both bands remain with the forearms in all eight sampled directions and both complete side64 strips,
without visible detached green fragments or long skin tethers. Bands stay associated with
swinging/raised arms through all three phases; no large shoulder wing or detached lower limb is
visible in inspected samples.

Simple band behavior only; local angular joint contours and simplified fingers remain. No loose
sleeve, high-resolution anatomy or continuous collision qualification follows from this result.

### asymmetric-mark: pixal3d, r1, effective seed 0

Main body remains connected at delivered scale, while red surfaces appear as thin strips/fins at
both sides of the hips in several front/rear frames. This does not preserve the detached rest object
as a stable accessory. The red surface folds, stretches and changes silhouette around the hip/hand
area through takeoff and landing, remaining conspicuous beside the body in airborne views.

All eight sampled isometric directions and every side64 frame were reviewed for four motions. Images
establish visible instability but not whether red surfaces are duplicated geometry or one stretched
component. Invalid asymmetry input is excluded from valid totals; correct attached-asymmetry
controls remain separate.

### asymmetric-mark: pixal3d, r2, effective seed 1000

No walk output: retarget refuses spine_01 because it does not descend from pelvis, after draft
rigging completes. No jump or final deliveries completed. This detached-input stress result does not
qualify the correctly attached one-sided band.

Reference/rest-only review; component appearance is not an audited topology count. Invalid input
remains excluded from valid-reference qualification totals and original receipt remains unchanged.

### asymmetric-mark: trellis2-4b, r1, effective seed 0

Main body stays connected at sampled scale, while the red object becomes a thin needle/fin extending
from the hip/waist. Its shape is visibly unlike the rest cylinder. Red surface folds into triangular
shards and floats beside the torso/hip during takeoff, airborne and landing. Shape/attachment
instability remains even though export succeeds.

All eight sampled isometric directions and every side64 frame were viewed across four motions. Cause
of the dark patterns is not established from images. This detached-input stress case is excluded
from valid-reference and attached-asymmetry qualification.

### asymmetric-mark: trellis2-4b, r2, effective seed 1001

Main body stays connected at sampled delivery scale, while red thin strips/fins appear around the
hip and waist instead of the detached rest cylinder. The red object folds into a hook/shard and
floats near the torso/hip through takeoff, airborne and landing. The shape is unstable despite
completed export sheets.

All four motions were viewed in eight sampled isometric directions and every side64 frame. Invalid
asymmetry input remains outside qualification totals; this does not contradict the corrected
attached-band result or establish geometry duplication from images alone.

### female-separated: pixal3d, r1, effective seed 0

All eight sampled directions show coherent arms, hips and feet without the hand/trouser tethers seen
on Amy. Shoulder contours remain intact at the delivered scale. Start, airborne and landing keep
readable folded legs and continuous shoulders; no obvious large mesh tear or detached feet in
inspected frames or full side strips.

The dark nape patch needs closer material/normal review; this image review does not establish its
cause. Fine fingers and larger-output details remain unqualified.

### female-separated: pixal3d, r2, effective seed 1000

All eight sampled directions retain intact shoulders, hands and feet; gait remains legible in both
full side64 strips. Start, airborne and landing remain connected through squat and raised arms. No
major shoulder tear or loose-surface tether is visible in the inspected samples.

Close-fit body control with no loose garment. Local joint contours, fine digits, unsampled contact
and larger output remain unqualified.

### female-separated: trellis2-4b, r1, effective seed 0

Coherent shoulders, hands and bare feet in eight sampled directions; side64 walks remain readable
without visible detached pieces. All three jump phases retain connected limbs and torso. Some
angular shoulder and elbow silhouettes remain, without obvious spikes or stretched sheets at this
scale.

Close-fit body control; eye/face detail needs identity approval. No garment collision or detailed
digit claim.

### female-separated: trellis2-4b, r2, effective seed 1001

Shoulders, hands and feet remain connected in eight sampled directions; full side64 strips show
coherent alternating steps. All three phases keep connected torso/limbs through the wide squat and
raised arms. No obvious large spike, skin tether or disappearing foot appears in inspected samples.

Requested 1000 became effective 1001 after material rejection. No loose clothing is present, and
detailed digit/contact/4K quality is not established.

### loose-cuffs: pixal3d, r1, effective seed 0

No walk output: retarget refuses spine_01 because it does not descend from pelvis, after the draft
UniRig stage completes. No jump or final deliveries completed. This remains a detached-component
stress case, excluded from valid cuff and generator qualification totals.

Reference/rest-only review. Apparent component count/placement is a thumbnail observation, not a
mesh-connectivity audit or evidence of sleeve behavior. Correct attached-cuff controls are reviewed
separately.

### loose-cuffs: pixal3d, r2, effective seed 1000

No walk output: retarget refuses spine_01 because it does not descend from pelvis, after the draft
rig completes. No jump or final delivery sheets completed. This is invalid cuff input and remains
detached-component stress, outside valid-reference qualification totals.

Only original reference and generated rest thumbnail were reviewed; apparent duplication is not a
connectivity audit. Correct attached-cuff controls, which complete with bands following the arms at
sampled scales, remain the cuff evidence.

### loose-cuffs: trellis2-4b, r1, effective seed 0

Body limbs remain connected, but the two green objects flatten/stretch into a long belt-like strip
across the hips in front/rear views instead of retaining their rest shape. Detached green pieces
curl, separate and float beside the waist/arms through takeoff, airborne and landing. This is
visible detached-surface deformation failure despite successful sheets.

Every side64 frame and four samples in all eight isometric directions were reviewed for all four
motions. This invalid-input stress case is excluded from valid-reference totals; it must not undo
the separately reviewed correct attached-cuff results or be presented as a normal sleeve benchmark.

### loose-cuffs: trellis2-4b, r2, effective seed 1000

The detached green components deform into a jagged belt-like strip across front/rear hips as the
otherwise connected body walks. This repeats the other TRELLIS seed stress failure. Green pieces
curl and float beside the waist/arms during takeoff, airborne and landing, and stretch back across
the hips in squat frames. Successful deliveries do not establish component ownership.

Four samples in all eight isometric directions and every side64 frame were reviewed across four
motions. Stress-only result, excluded from valid-reference qualification; this is not a corrected
attached-sleeve or garment-collision experiment.

### male-separated: pixal3d, r1, effective seed 0

All eight sampled isometric views and both full side strips retain hands, shoulders and feet without
visible tethers or shoulder spikes. Start, airborne loop and landing remain readable in all eight
sampled directions; no obvious skin/shorts tearing or disappearing lower limbs.

Simplified hand silhouettes and very small delivered fingers; no fine-detail or 4K acceptance. No
garment case here.

### male-separated: pixal3d, r2, effective seed 1000

Eight sampled isometric views and both full side strips remain coherent; no visible arm/trouser
tethers, shoulder spikes or missing feet. All three phases remain readable; the squat and raised-arm
silhouettes remain connected without obvious tearing at the sampled scales.

Simplified hand silhouettes; fine finger articulation, continuous contact and 4K detail remain
unqualified. No loose clothing.

### male-separated: trellis2-4b, r1, effective seed 0

Coherent front, rear and lateral silhouettes through eight sampled directions; no obvious shoulder
explosions or detached feet in side64 strips. Start, airborne and landing remain connected and
legible across sampled directions; hands stay simplified rather than proving correct digits.

Does not qualify fine fingers, continuous collision or larger output detail. Candidate r2 requested
1000 was regenerated at 1001 after a chrome-material rejection; reviewed r1 remains effective 0.

### male-separated: trellis2-4b, r2, effective seed 1001

All eight sampled directions retain coherent shoulders, hands and feet; full side64 strips show
readable alternating strides. Start, airborne loop and landing retain continuous limbs without a
visible large split. Local shoulder/elbow pinching and simplified hands remain noticeable in
enlarged crops.

Requested 1000 became effective 1001 after a rejected all-metal/chrome attempt. Small-sprite
observations do not approve detailed hand anatomy, continuous collision or 4K output.

### relaxed-arms: pixal3d, r1, effective seed 0

A large slab/wing of thigh/hip surface appears as the leg lifts, visible in front/oblique and side
views. The gait is readable but this is not an acceptable mesh deformation. The slab expands
strongly through jump-start and persists in airborne and early landing samples. Reported maximum
stretch is 28.16x for walk, 30.04x for jump-start, 29.38x airborne and 26.16x landing; jump-start's
stretched-edge fraction reaches 6.09%.

Cause is not assigned from images alone: topology/ownership, weights and skeleton/retarget pose
remain distinct possibilities. Seam separation stays0 and top motion.flags is empty, proving those
are not visual acceptance. No silent repair or rerig is applied.

### relaxed-arms: pixal3d, r2, effective seed 1000

No delivered walk: retarget refuses spine_01 because it does not descend from pelvis. This semantic
refusal is distinct from the already rejected extra floating parts. No jump or delivery sheets
completed. The first Pixal seed has a separate visible thigh deformation; this seed instead remains
a technical refusal with a bad generated rest asset.

Rest comparison only. A bodyCount1 receipt cannot certify absence of smaller disconnected parts. No
removal, anatomy invention or rig recipe change is applied.

### relaxed-arms: trellis2-4b, r1, effective seed 0

No walk output: automatic upright alignment refuses uncertainty before prediction. This is an
orientation refusal, separate from the unrequested generated surface. No jump or final deliveries
completed. Controlled recipe remains unchanged; no orientation opt-out has been applied to this
case.

Reference/rest review only. The white sheet's exact geometry/material cause is not established by
thumbnail inspection, and no automatic removal is authorized as a quality repair.

### relaxed-arms: trellis2-4b, r2, effective seed 1001

No walk output: retarget refuses spine_01 because it does not descend from pelvis, after UniRig
reports a completed rig. No jump or delivery sheets completed. None of the four controlled
relaxed-arm candidates is currently accepted end-to-end: one completes with visible thigh
deformation and three refuse before motion.

Rest-only visual review; no silent skeleton renaming or generation retry is introduced. This small
controlled pose case is evidence of risk, not a population success-rate estimate.

### short-broad: pixal3d, r1, effective seed 0

No walk output: retarget refuses foot_l because it does not descend from calf_l. UniRig stage
completion did not yield a usable motion preview. No jump or final deliveries completed. Keep this
technical refusal outside the valid-reference generator totals.

Reference/rest comparison inspected only. Corrected framed-broad supplement supplies the separate
full-hand reference; baseline outputs are not overwritten.

### short-broad: pixal3d, r2, effective seed 1000

No delivered walk: retarget refuses thigh_l because it does not descend from pelvis, after UniRig
reported a completed rig. No jump or delivery sheets completed; this failure stays outside
valid-reference qualification totals but remains a recorded retained case.

Rest comparison inspected only. No inference about missing generated hand geometry follows from
thumbnail cropping.

### short-broad: trellis2-4b, r1, effective seed 0

Body, shoulders and feet remain connected across eight sampled directions and complete side64
strips. Arms/hands are simplified and elongated; no large surface tether appears. Three jump phases
remain readable, with angular thighs/knees and continuous limbs in inspected samples. This is
cropped-input stress only, outside valid-reference totals.

Cannot qualify complete hands from a cropped reference or prove continuous collision, 4K anatomy or
reliable broad-body behavior; corrected framed-broad runs are separate.

### short-broad: trellis2-4b, r2, effective seed 1001

Limbs remain connected across sampled directions and full side64 strips, but the conspicuous black
upper-back region persists through rear walk views. This is not visually accepted despite pipeline
completion. The black region persists across start, airborne and landing rear/oblique views. No
large skin tether is apparent; the patch's material/normal/geometry cause is not established by this
image review.

Cropped baseline input is invalid for full-hand acceptance and excluded from valid totals. Rear
appearance is rejected separately from motion connectivity; no guessed automatic repair or rerig is
applied.

### skirt: pixal3d, r1, effective seed 0

Skirt visibly buckles with alternating legs and has dark surface patterning. Technical sheets are
readable but do not establish clean clothing coverage. Takeoff squat buckles the skirt into a broad
horizontal ribbon/loop with legs protruding through/around its surface; airborne and early landing
retain severe folded shapes. This is a visual rejection beyond private Bulma.

Cause is not assigned from image inspection alone. Maximum edge stretch ranges3.59x–6.21x across
motions while coincident seam separation stays0, so neither moderate stretch nor seam continuity
certifies a wearable garment. No repair is silently applied.

### skirt: pixal3d, r2, effective seed 1000

The leading hem bulges as the leg lifts, with conspicuous dark surface patterning. Readable output
is not evidence of clean clothing coverage. Takeoff squat rolls the skirt into a broad horizontal
loop/ribbon and lets legs protrude through or around it. Airborne motion has an asymmetric bell-like
bulge, and early landing repeats the severe rolled garment shape across the sampled directions.

All four motions were reviewed in eight sampled isometric directions and every delivered side64
frame. Cause is not assigned from images alone; clothing motion is rejected without silently
deleting or replacing generated surfaces.

### skirt: trellis2-4b, r1, effective seed 0

The garment stays more cone-like than the two Pixal candidates, and body motion is connected at
delivered scale. This does not establish garment collision or fine hand quality. Knees/thighs
visibly protrude through the front and side of the skirt in the takeoff squat and early landing,
across several sampled directions. The cone remains relatively rigid rather than the large rolled
Pixal ribbon, but clothing coverage still fails.

All eight sampled isometric directions and every side64 frame were reviewed for all four motions.
This is a separate visible clipping failure, not a causal diagnosis or model-architecture ranking;
no collision repair was applied.

### skirt: trellis2-4b, r2, effective seed 1000

Body motion is connected and the faceted skirt retains a mostly cone-like shape at sampled delivery
scale. This does not establish collision or fine anatomy quality. The takeoff and landing squats
expose knees/thighs protruding through the front/side garment surface; side and oblique views make
the clipping clear. Airborne skirt stays relatively rigid. All four valid skirt candidates complete
technically and all four fail visual clothing review.

All eight sampled isometric directions and every side64 frame were viewed across four motions. No
causal distinction between ownership, weights, topology and collision is inferred from pixels alone,
and no repair has been applied.

### tall-slim: pixal3d, r1, effective seed 0

No delivered walk review: motion-review bake refuses a contradictory semantic skeleton hierarchy
(spine_01 is prediction root0, pelvis is its child7; animation requires spine_01 below pelvis). No
jump phases or delivery sheets completed; rig-stage success alone is not an end-to-end success.

Rest comparison inspected only. Detailed hierarchy is retained in private tall-hierarchy-audit.json.
Do not convert this technical refusal into visual motion approval or hide the original generated
objects.

### tall-slim: pixal3d, r2, effective seed 1000

No delivered walk review: motion-review bake refuses a contradictory semantic skeleton hierarchy
(thigh_r is prediction root0, pelvis is its child9; animation requires thigh_r below pelvis). No
jump phases or delivery sheets completed; rig-stage success alone is not an end-to-end success.

Rest comparison inspected only. Detailed hierarchy is retained in private tall-hierarchy-audit.json.
Do not convert this technical refusal into visual motion approval or hide the original generated
objects.

### tall-slim: trellis2-4b, r1, effective seed 0

Eight sampled isometric directions and every side64 frame retain coherent shoulders, hands and feet.
No visible long skin tether or missing limb appears. All three phases remain connected across the
eight sampled directions. Knees/elbows and shoulder contours are angular, but no large shoulder
split or detached foot is seen at delivered scale.

Simplified rest hands remain an appearance problem; motion coherence does not qualify detailed
fingers, 4K anatomy or continuous contact. The two Pixal results of this valid reference separately
fail skeleton hierarchy and have unrequested lateral objects.

### tall-slim: trellis2-4b, r2, effective seed 1000

All eight sampled isometric directions and full side64 strips keep coherent shoulders, hands and
feet without large stretched sheets. Start, airborne and landing remain connected across inspected
directions; angular knees and shoulders remain but no obvious large spike or detached lower limb
appears.

The head stripe and simplified hands need appearance approval. Fine digits, continuous collisions
and high-resolution anatomy are not established.

### framed-broad: pixal3d, r1, effective seed 0

No delivered walk: retarget refuses thigh_r because it does not descend from pelvis. This is a
downstream semantic-hierarchy failure, distinct from generation completion or appearance. No jump or
delivery sheets completed. Keep the failed valid-reference case in the denominator.

No motion review. The wider camera diagnostic renders the original unskinned generation result,
preserves its SHA and does not replace the controlled evaluation. Its owned worker completed in 1.39
s with 349 MiB peak working set; raw stage files reuse a shared job slug and are not
candidate-specific naming provenance.

### framed-broad: pixal3d, r2, effective seed 1000

No delivered walk: retarget refuses foot_l because it does not descend from thigh_l. The rig stage
reported success, but the named skeleton is not usable by the animation contract. No jump or
delivery sheets completed. Both Pixal seeds on the valid framed-broad control therefore remain
end-to-end technical failures.

Rest thumbnail only for this seed; wider original-GLB diagnostic exists for seed 0 only. Do not
extrapolate that seed 0 geometry diagnostic to this seed or replace the original clipped thumbnail
with a later UI framing fix.

### framed-broad: trellis2-4b, r1, effective seed 0

No walk output: automatic upright alignment reports uncertainty and refuses before UniRig
prediction. This is an orientation refusal, not a semantic-ancestry or final motion failure. No jump
or delivery sheets completed. Turning off upright alignment would be a separate recovery trial and
has not been done to this controlled result.

Rest comparison only. Original failed receipt remains authoritative; no geometry or orientation fix
is silently applied.

### framed-broad: trellis2-4b, r2, effective seed 1000

Eight sampled isometric directions and complete side64 strips retain connected torso, shoulders and
feet without obvious long tethers or missing limbs. Three phases remain readable and connected;
shoulders/armpits and hand outlines are angular, and large simplified hands remain conspicuous in
oblique views.

This is the one technically complete default framed-broad result so far; it does not erase the other
seed's upright refusal or the Pixal semantic failures. Detailed hand quality and high-resolution
deformation are not accepted.

## Downstream refusal classes

Semantic naming/ancestry refusal is a downstream failure class: generation and finite skin weights
can complete while the named skeleton contradicts the animation contract. These runs retain their
original recipe and failed receipts. Rebuilding under another adapter/recipe would be a separate
experiment.

| Case                                   | Input scope              | Failure class                               | Retained error                                                                                                                                                    |
| -------------------------------------- | ------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| asymmetric-mark-pixal3d-evaluation-r2  | flawed-input stress only | Semantic skeleton hierarchy                 | retarget: joint "spine_01" must descend from "pelvis"; its names contradict the animation skeleton. Rebuild the rig in the Rig stage before previewing or baking. |
| loose-cuffs-pixal3d-evaluation-r1      | flawed-input stress only | Semantic skeleton hierarchy                 | retarget: joint "spine_01" must descend from "pelvis"; its names contradict the animation skeleton. Rebuild the rig in the Rig stage before previewing or baking. |
| loose-cuffs-pixal3d-evaluation-r2      | flawed-input stress only | Semantic skeleton hierarchy                 | retarget: joint "spine_01" must descend from "pelvis"; its names contradict the animation skeleton. Rebuild the rig in the Rig stage before previewing or baking. |
| relaxed-arms-pixal3d-evaluation-r2     | valid reference          | Semantic skeleton hierarchy                 | retarget: joint "spine_01" must descend from "pelvis"; its names contradict the animation skeleton. Rebuild the rig in the Rig stage before previewing or baking. |
| relaxed-arms-trellis2-4b-evaluation-r1 | valid reference          | Upright alignment refusal before prediction | Upright alignment is uncertain for this mesh. Turn off "Stand model upright" to keep its current pose.                                                            |
| relaxed-arms-trellis2-4b-evaluation-r2 | valid reference          | Semantic skeleton hierarchy                 | retarget: joint "spine_01" must descend from "pelvis"; its names contradict the animation skeleton. Rebuild the rig in the Rig stage before previewing or baking. |
| short-broad-pixal3d-evaluation-r1      | flawed-input stress only | Semantic skeleton hierarchy                 | retarget: joint "foot_l" must descend from "calf_l"; its names contradict the animation skeleton. Rebuild the rig in the Rig stage before previewing or baking.   |
| short-broad-pixal3d-evaluation-r2      | flawed-input stress only | Semantic skeleton hierarchy                 | retarget: joint "thigh_l" must descend from "pelvis"; its names contradict the animation skeleton. Rebuild the rig in the Rig stage before previewing or baking.  |
| tall-slim-pixal3d-evaluation-r1        | valid reference          | Semantic skeleton hierarchy                 | retarget: joint "spine_01" must descend from "pelvis"; its names contradict the animation skeleton. Rebuild the rig in the Rig stage before previewing or baking. |
| tall-slim-pixal3d-evaluation-r2        | valid reference          | Semantic skeleton hierarchy                 | retarget: joint "thigh_r" must descend from "pelvis"; its names contradict the animation skeleton. Rebuild the rig in the Rig stage before previewing or baking.  |
| framed-broad-pixal3d-evaluation-r1     | valid reference          | Semantic skeleton hierarchy                 | retarget: joint "thigh_r" must descend from "pelvis"; its names contradict the animation skeleton. Rebuild the rig in the Rig stage before previewing or baking.  |
| framed-broad-pixal3d-evaluation-r2     | valid reference          | Semantic skeleton hierarchy                 | retarget: joint "foot_l" must descend from "thigh_l"; its names contradict the animation skeleton. Rebuild the rig in the Rig stage before previewing or baking.  |
| framed-broad-trellis2-4b-evaluation-r1 | valid reference          | Upright alignment refusal before prediction | Upright alignment is uncertain for this mesh. Turn off "Stand model upright" to keep its current pose.                                                            |

Raw UniRig align/merge files share the job slug and are not archived per candidate. Retained rig
GLB, skeleton, run receipt and command transcript/logs are the audit evidence; original prediction
indices are known when reordered=false, but unarchived raw bone-name spellings must not be guessed.

## Pipeline provenance and chronology

Generator recipes were frozen before evaluation. Evaluation did not use one byte-identical pipeline
build: importer normalization correction `0db0ffa` landed on 2026-10-23 at 18:14 PDT while the run
was active, changing recorded importer 0.1.0 to 0.1.1 for later children. The correction changes
normalization of existing authored skins; these generated input GLBs are unskinned, and the static
vertex-normalization branch remains unchanged. No generator quality gain is attributed to that
importer/metadata change. UniRig adapter 1.3.1 remains the controlled adapter.

| Derived importer version | Recorded child instances | Cases                                                                                                                                                             |
| ------------------------ | -----------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spritebook-import@0.1.0  |                        7 | female-separated-pixal3d-evaluation-r1, female-separated-pixal3d-evaluation-r2, female-separated-trellis2-4b-evaluation-r1; full list in private index.json       |
| spritebook-import@0.1.1  |                       37 | attached-asymmetry-pixal3d-evaluation-r1, attached-asymmetry-pixal3d-evaluation-r2, attached-asymmetry-trellis2-4b-evaluation-r1; full list in private index.json |

Private evidence records each child manifest source/importer, canonical GLB SHA and glTF generator,
input skin count, rig backend and adapter, naming/reorder receipt and original generation GLB hash.
A generic glTF-Transform asset.generator field is not an importer-version receipt.

After all 44 evaluations finished, a metadata-only replay validated the frozen source bytes and
preserved failures without rerigging or retries. Final index receipt hashes reflect that replay.
Comparison with 43 saved pre-replay receipt snapshots finds only generationMeta/generationWarnings
changed; technical outcomes, source, motion and delivery fields are unchanged. The last receipt was
first indexed after replay. The private metadata-replay-audit.json retains this chronology. Later
authored-import fixes and the separately tested thumbnail framing update do not improve or replace
these controlled generated outputs.

## Separate orientation recovery: excluded from the controlled 44

**framed-broad TRELLIS.2 r1 effective 0, copied workspace, --no-upright**

A separate copied-workspace --no-upright attempt completes draft UniRig plus four-motion review in
200.03 s, then 72 side64 and 288 iso256 frames. Receipts verify original source/manifest
preservation. The first recovery-result.json is a harness I/O failure before any job;
recovery-r1-result.json and delivery-result.json are the completed attempt. None replaces the
controlled default's upright refusal or increases its success counts.

Across four delivered samples per clip in all eight isometric directions and all side64 frames, the
recovery has connected shoulders, torso and feet through walking, takeoff, airborne and landing; no
large thigh wing or skin tether is apparent. Hands remain elongated/simplified, eye/face appearance
differs from the reference and local joint contours are angular. This is sampled motion coherence,
not detailed anatomy or collision approval.

This proves an explicit orientation opt-out can recover one uncertain-upright case. It does not
justify automatically bypassing orientation gates, changing defaults, fixing semantic-name failures
or claiming general broad-body success. The later thumbnail framing fix is separately tested and
does not replace any original cohort thumbnail.

Private separate-no-upright-recovery/evidence.json and source
.render-bench/candidate-orientation-2026-10-23/ retain receipt hashes, preserved-source proof and
deliveries.

## Recorded costs and tested machine

Local machine: Windows 11 Pro x64, OS build 10.0.26200; Intel Core i9-10900K (20 logical CPUs), 63.9
GiB RAM, NVIDIA RTX 3090 with 24 GiB VRAM, driver 610.88, Node v24.22.0, Dawn/Vulkan. These are
tested-host facts, not minimum requirements. No other native platform or weaker GPU is qualified by
this cohort.

The cost table includes all retained valid and flawed-input stress generation batches; it is a
workload-cost record, not the valid-reference qualification denominator. Generation batch wall time
is recorded once for the two candidates. Worker cold loading and candidate model work are separate
measurements; the latter excludes GLB encoding/UV/export and includes bounded material retries for
TRELLIS.2. Batch wall time also includes startup, admission/queueing and processing overhead. None
of these measurements is a GPU-kernel-only benchmark.

| Model       | Completed generation batches | Cold worker load             | Per-candidate model work  | Two-candidate batch wall     | Peak Torch reserved         |
| ----------- | ---------------------------: | ---------------------------- | ------------------------- | ---------------------------- | --------------------------- |
| pixal3d     |                           11 | 93.4–124.5 s (median 106.5)  | 33.5–95.9 s (median 42.9) | 271.2–615.4 s (median 312.5) | 17.5–17.6 GiB (median 17.5) |
| trellis2-4b |                           11 | 100.6–131.0 s (median 115.4) | 22.4–50.7 s (median 30.6) | 238.5–635.5 s (median 275.4) | 3.0–3.0 GiB (median 3.0)    |

The 44 recorded candidate evaluations take 117.2–702.4 s (median 256.8) each. Successful paths
include draft-rig/motion review and both delivery profiles; failed paths stop at their refusal and
do not include completed exports. Cached draft candidates and cold candidates coexist, and
concurrent generation can add queue time; do not attribute this range to model inference alone or
add each result's shared generation batch twice.

Successful evaluations separately: 117.2–702.4 s (median 266.1) across 31 receipts.

Failed/incomplete evaluations separately: 118.3–584.9 s (median 128.4) across 13 receipts; time
spent waiting for admission remains charged even if a later orientation or semantic gate refuses.

UniRig's 31 recorded first-physical-GPU samples peak at 16.9–20.0 GiB (median 16.9). This
device-wide `nvidia-smi memory.used` measure includes other GPU clients; it has a different scope
from the generator's Torch allocator peaks. It is neither an isolated model footprint nor a newly
established minimum. Stage timings in private `costs.json` include subprocess/model loading, not
just inference.

Pixal3D uses `1024_cascade`, 12 steps, 2048px textures and a 200k-triangle target; TRELLIS.2 uses
its low-VRAM `512` recipe, 12 steps and 2048px textures with bounded material retries. Both use the
same requested seeds and reference images, but these differing shipping recipes prevent a pure
model-architecture speed or quality ranking. Existing
[platform/model gates](../docs/platform-support.md) remain authoritative.

## Seed and retry provenance

Requested candidate seeds are 0 and 1000, but ranking can change result order and TRELLIS.2 can make
bounded material-quality retries. Effective seeds come from each result receipt and are
cross-checked against `character/results/r1/gen-meta.json`; they must not be inferred from
`r1`/`r2`. Rejected attempts stay in generation warnings and `seedsTried`.

- `attached-asymmetry-trellis2-4b`: requested 1000, effective 1001; attempted 1000, 1001. This retry
  is not a matched successful run of the requested seed.
- `attached-cuffs-trellis2-4b`: requested 1000, effective 1001; attempted 1000, 1001. This retry is
  not a matched successful run of the requested seed.
- `asymmetric-mark-trellis2-4b`: requested 1000, effective 1001; attempted 1000, 1001. This retry is
  not a matched successful run of the requested seed.
- `female-separated-trellis2-4b`: requested 1000, effective 1001; attempted 1000, 1001. This retry
  is not a matched successful run of the requested seed.
- `male-separated-trellis2-4b`: requested 1000, effective 1001; attempted 1000, 1001. This retry is
  not a matched successful run of the requested seed.
- `relaxed-arms-trellis2-4b`: requested 1000, effective 1001; attempted 1000, 1001. This retry is
  not a matched successful run of the requested seed.
- `short-broad-trellis2-4b`: requested 1000, effective 1001; attempted 1000, 1001. This retry is not
  a matched successful run of the requested seed.

## Evidence and remaining qualification

The private `.render-bench/cohort-review-2026-10-23/index.json` links every completed evaluation
receipt, reference hash, effective seed, numeric motion diagnostics, generation warnings and
delivery directories. `visual-notes.json` records the reviewed images and findings separately.
Original outputs remain under `.render-bench/character-cohort-2026-10-23/`,
`.render-bench/character-attached-controls-2026-10-23/` and
`.render-bench/character-framed-control-2026-10-23/`; no live Amy/Bulma workspace or evolving
evaluation receipt is modified by review.

All 44 retained evaluations are indexed and visually reviewed, including rest-only technical
refusals. These observations do not qualify new binders, automatic cloth correction, fine fingers,
other native platforms, weaker hardware, engine integration or continuous motion/contact. No
generator-wide reliability ranking is justified by a small, related procedural cohort.
