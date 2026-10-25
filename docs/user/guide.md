# SpriteBook Studio user guide

**Start without model downloads:** New character → **Use a mesh or offline example** opens the
bundled CC0 humanoid or an existing mesh. Existing skinning is preserved and starts unaccepted;
review walking and jumping in Rig. Static imports still need a rig. Import is reversible and records
source provenance.

**SpriteBook is a Windows capture/export preview.** Generated rigs may stretch hands or clothing and
permit legs to intersect loose skirts. Inspect animations before baking; accepting a rig does not
fix these issues. See the [preview notes](../../CHANGELOG.md) for the supported scope.

The installed app includes its core runtime. Contributors can build a local Windows candidate with
`npm run build:desktop`; see [development setup](../developer/development.md) and
[platform support](../platform-support.md). Each primary action has a CLI twin in the app; see
[the CLI reference](cli.md).

SpriteBook turns a character image into engine-ready 2D spritesheets on your machine. Model and
runtime setup downloads third-party files; character generation and capture run locally.

Studio is the guided editor. It has six stages, from the source image to the exported files. Each
stage wraps a command of the SpriteBook CLI. The CLI does everything Studio does, and each primary
button shows the exact command it runs. To work in the terminal instead, read
[the quickstart](quickstart.md).

This guide is about the app. Read the quickstart first if you want the shortest path to a
spritesheet.

Some screenshots show earlier browser-demo controls with synthetic data. The current Look workbench
is described below; colored demo frames in historical images are not generated character output.

## 1. Open a project

![The gallery](../img/gallery.png)

A **workspace** is one folder for one character. It holds the manifest, the mesh, the bakes, and the
exports. A **projects root** is a folder that holds many workspaces.

1. Start SpriteBook Studio.

2. Type the path of your projects root in the **Projects root** box.

3. Select **Load**, or press Enter.

The gallery shows one card for each character in the root. Select a card to open that character in a
workspace. Select **New character** in the gallery header to make another. The left character index
appears when editing, where it lets you switch characters without returning to the gallery.

While editing, the character index holds the gallery and the loaded roster. Opened entries can be
closed with their close control or the Delete key; this leaves the character's files intact. Use the
sun/moon icon in the compact title bar to switch between light and dark appearances. Choose **Edit →
Language** for a language; **File → Shortcuts** opens the command palette. The status bar at the
bottom shows GPU identification, the character count, the bridge (which engine runs your commands:
`tauri` is the real CLI, a browser preview is a demo), and the log handle (opens the session log —
every line the CLI writes). **File → About SpriteBook** shows the installed version and a link to
the project on GitHub.

To remove generated files, right-click a character and choose **Delete project…**, or use **Edit →
Delete project…**. Confirm the named project in the dialog. This permanent cleanup has no undo; it
preserves original inputs, unknown user files and machine model installations. See
[projects and files](projects.md#delete-a-project) for the deletion boundary and backup guidance.

To check your machine, select **Run health exam**. It reports the GPU, the sidecar (the local Python
helper process that runs the AI models), and the installed models.

## 2. Stage 01 — Generate

Generate makes a 3D mesh from one image. It then saves one result as the **canonical mesh**.

Stages 02 to 06 stay locked until a canonical mesh exists. The rail states this instead of hiding
it.

To make a character:

1. Select **New character** in the gallery header or character index.

2. Type a name. Studio makes the character id below the box. The id is lowercase letters, digits,
   and dashes.

3. Type the path of your source image, or drop the image on the window.

4. Select a backend using the radio choices in the right settings panel. They come from the model
   catalog and show VRAM needs and install state. **Model details** discloses the selected license;
   installation requirements remain visible.

   Complete TRELLIS.2 and Pixal3D recipes include a separately gated DINOv3 conditioner. Review
   [licensing](../licensing.md) and accept the declared terms before installation. The selected
   Windows runtimes replace the historical evaluation-only rasterizers; component terms still apply.
   [Models and local runtimes](models.md) lists each role, hardware requirement and setup.

   Development builds expose `fixture-gen` last under **Development tools**. This synthetic stand-in
   proves the pipeline without a GPU and does not produce a likeness. Production UI omits it; the
   CLI remains available for development and existing fixture projects.

5. Check the **Height (m)** field. The default is 1.7. CAUTION: this is the size every later stage
   believes. Sprites frame at pixels-per-metre, so a character that keeps the backend's own scale
   bakes about 30 px tall. Clear the field only when you want the backend scale; the job then warns
   and states the measured height.

6. Change the common generation settings if needed. **Advanced options** holds the remaining schema
   fields and backend comparison. Only values that differ from the backend's defaults travel to the
   command. The reference stays on the left; settings scroll above the fixed action footer.

7. Select **Generate model**.

Generate removes the background automatically when the source is opaque, before loading the 3D
model. This uses the installed **U²-Net** (`rembg-u2net`) model; if it is missing, the error offers
**Manage extensions**. Transparent 8-bit RGBA PNGs pass through unchanged. Preparation appears in
the job progress and runs once for the candidate batch; retries reuse the verified cutout. Your
original reference is retained, and preparation is recorded as an undoable source edit.

The button stays disabled until the form is complete. The text below it names what is missing.
During generation, an activity panel shows elapsed time and the stage reported by core. Different
stages have different costs, so there is no overall percentage or time estimate. **Stage details**
shows the raw progress units. **Cancel job** stops the owned job and reports cancellation separately
from failure.

The run writes one or more candidates. Each card shows the seed, the triangle count, the texture
size, and the wall time. Select **Inspect** to see a candidate in the 3D viewport.

To keep a candidate, select **Save as canonical mesh**. This is the checkpoint. The other stages
unlock. Saving preserves the candidate's geometry and textures exactly, and the viewport switches to
the saved canonical mesh. Rig uses that same saved asset.

Open a candidate's **More actions** for **More like this** (the same recipe with a new seed),
**Re-texture**, and that candidate's canonical-save CLI command.

Under **Canonical mesh options**, two options apply at the moment you save: **reproject source
detail** and **match source colours**. Both are off by default. Enable them only when you want to
change the generated texture using the reference. Reprojection paints the reference onto the front
of the mesh; differences in pose or proportions can distort it. These changes are included in the
undoable save; the candidate remains unchanged, so you can save it again with both options off to
recover its generated texture.

**The CLI twin:** `spritebook gen` and `spritebook pick`.

## 3. Stage 02 — Rig

Rig gives the mesh a skeleton, so the animation clips can move it.

Choose the method by what should happen to your mesh:

- **Rig this model — UniRig.** Keeps your generated geometry and textures, predicts joints and skin
  weights on the GPU. This is the default for generated humanoids as well as other characters.
- **Fit a template body.** Replaces generated geometry with a fitted, already rigged body. It uses
  the CPU and needs no model download. Keep `ubc-male` under **Template body** for the bundled
  default; other bodies take explicit bundle directories. This changes the character's geometry.

Select **Build rig**. These methods are called Track B and Track A respectively in the CLI; **About
these methods** explains those names. After a rig exists, **Rebuild method** keeps the choices
disclosed so orientation and repair controls have room.

The mesh stays left and the inspector stays right. The skeleton overlay includes joint markers; blue
means not flagged by the deformation tests, amber means flagged, and white means selected. **Through
mesh** keeps the skeleton visible through the surface. **Front**, **Side** and **Rear** move the
camera; they do not alter the model or rebuild anything.

The first UniRig build enables **Stand model upright**, front detection, grounding and centering.
Uncheck upright alignment to preserve an intentional lean. Upright corrects the dominant body axis
while retaining the declared height; ground and center only change position. An ambiguous upright
estimate refuses with an instruction to turn it off. Front detection can also be uncertain: inspect
the result and use a numeric turn when needed.

For an existing rig, **Auto align and rebuild rig** combines those four operations. **Adjust
alignment** exposes individual choices and **Apply orientation and rebuild rig** submits them. A
numeric turn previews the rotation; the other changes take effect on rebuild. This runs prediction
and skinning again; undo restores the prior recorded rig. Template fitting uses the template
skeleton and does not accept these repair switches.

The **Bend checks** below the canvas retain every reported finding, worst stretch first. Amber means
the surface needs review under a test bend, even when the joint is well placed. **Edges stretched**
gives the affected fraction as well as the worst edge. A joint can drive several valid mesh parts,
including clothing or accessories; that count alone does not mean a tear. Click a joint name to
select and frame it. A joint without a flag has only passed those numerical tests; inspect its
anatomy too. **Preview selected joint bend** writes a CPU-generated ±30° diagnostic animation using
the same pose axis as the check. Pause or scrub it in the viewport; **Return to rest pose** returns
to the saved model. Previewing does not change the rig or its acceptance.

The inspector's **Motion check** lets you select a library clip and **Preview motion** before
accepting the rig. Check `walk-loop`, the `jump-start`/`jump-loop`/`jump-land` phases and `a-tpose`
for raised arms. The CLI twin is `spritebook anim --preview <clip> --workspace <dir>`. This uses
core-retargeted motion without enabling the clip or changing the source mesh. Return to rest before
drafting joint edits; apply or discard pending edits before previewing movement.

Predicted joint counts and hand detail vary between characters. A wrist with one branch is not five
independently mapped fingers. When separate finger motion is unavailable, the screen says so and
hands follow the wrists. Check both walking and an arms-raised pose: hands resting against clothing
can receive incorrect weights that become obvious only when the limbs separate.

On a UniRig rig at rest, drag the move handles to draft a position edit. **W** selects move and
**Q** changes local/world axes; rotation and scale handles are not offered because the edit contract
carries positions. Mirroring is optional. Applying edits runs the rig again. **Repair tools**
discloses automatic position hints and an edits-file path. Hints can help placement; they cannot fix
a wrong hierarchy, detached geometry or missing prediction detail.

**Accept rig** records your review. It does not repair the model or certify its anatomy. A bake with
an unaccepted rig warns but still runs. Review the skeleton, diagnostic motion and report before
accepting.

**The CLI twin:** `spritebook rig`. See
[rig flags and diagnostic previews](cli.md#rig--a-skeleton-for-the-canonical-mesh).

## 4. Stage 03 — Animate

Animate selects the clips to bake. The bundled library has 86 clips, with 8-direction locomotion.

To add a clip:

1. Type in the **Search** box, or select a **Category**.

2. Select **Enable** on the clip you want.

The clip appears as a binding row. Each row has three values:

- **frames** — how many frames to bake for this clip.
- **speed** — the playback rate.
- **hold last frame** — on for a clip that must stop, such as a death.

Change a value, then select **Record change**. Nothing is recorded until you do.

Select **Disable** to remove a clip. The numbers stay, so a later **Re-enable** brings them back.

The frame count controls the bake cost. Frames per clip, times directions, times clips, gives the
total frames. The stage shows this arithmetic.

**The CLI twin:** `spritebook anim --enable` and `spritebook anim --disable`.

## 5. Stage 04 — Look

Look composes one sprite frame before you commit to a full bake. The left workspace contains a 3D
aiming view and a flat frame rendered by core. The right inspector contains the capture recipe.

Start with **Side-scroller** for two opposite side views or **Isometric** for eight elevated views.
Orbit the 3D view to aim; scroll to adjust scale. The frame guide marks the capture area. The 3D
view is an inspection instrument: lighting and finish are verified in the flat rendered frame.

| Control               | What it does                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------- |
| **Projection**        | orthographic world scale or perspective with a field of view                             |
| **Elevation / Turn**  | aim above the ground and around the character                                            |
| **Pixels per metre**  | adjust world scale; use the same ruler across a roster                                   |
| **Directions**        | bake 2, 4, 8 or 16 views                                                                 |
| **Lighting & finish** | key-light direction, ambient fill, light frame and finish                                |
| **Output cell**       | independent width/height, size shortcuts from 64px to 4K, ground margin and antialiasing |
| **Preview sample**    | select an enabled animation, frame and direction                                         |

**Original · full color** uses the existing Clean recipe without palette quantization, outlines or
dithering. Pixel, cel and painterly finishes remain available. Antialiasing changes the internal
render resolution; it does not change the output cell dimensions. Large cells and higher
antialiasing need more memory. Unsupported GPU sizes fail with an instruction to reduce them.

Select **Render frame** after changing the camera, finish or sample. Core prepares the clip and
renders that frame through the same pipeline as Bake. An old frame remains visible with a stale
label until the new one arrives. Adaptive-palette previews are provisional until the full clip is
baked. **Actual pixels** inspects large full-color frames at native size; pixel finishes retain
integer nearest-neighbor zoom.

The inspector uses the character name. Drag its boundary or use its focused Left/Right keys to
resize; its chevron collapses and reopens it without discarding drafts.

Select **Save look** to record the recipe, or **Save look & bake animations** to save and move to
Bake. Saving is journaled and reversible. Rendering a preview does not save settings, select a new
bake or replace the last export. A changed look invalidates the baked frames; Bake renders the whole
selected animation set with the recorded recipe.

**The CLI twins:** `spritebook look` and `spritebook look --preview --clip walk-loop --frame 0
--direction 0`. See [capture flags](cli.md#look--the-camera-and-style-decision).

## 6. Stage 05 — Bake

Bake renders every frame and packs them into spritesheet pages.

1. Select **Bake sheet**.

The progress line reports the four steps of the bake. The estimate stays silent until it is honest.

When the bake completes, the **Review** section appears. It reports the frame count, the cache hit
rate, the flicker percentage, and the wall time.

The player shows the result:

- **Clip** selects the animation.
- **d0** to **d7** select the direction.
- **Pause** stops the player. **fps** sets the rate.
- **1x**, **2x**, **4x** set the zoom. The zoom is always an integer, with nearest-neighbour
  sampling, so what you see is the real pixels.
- **lit**, **albedo**, **normal**, **depth**, **mask** select the render pass. Every pass page has
  the same layout as the lit page. The player loads the page referenced by the selected frame,
  including older bakes whose animations cross pages.

**Quality flags** report problems the bake found. Each flag names the stage that owns the fix, and
its button takes you there.

| Flag                      | What it means                                                               |
| ------------------------- | --------------------------------------------------------------------------- |
| `silhouette-clipped`      | the character reaches the cell edge. The flag states the edge and the width |
| `outline-exceeds-padding` | the outline is wider than the padding, so it is cut                         |
| `anim-foot-contact`       | a planted foot leaves the ground in a clip                                  |
| `anim-unmapped-core`      | a core joint of the clip has no match in the rig                            |
| `mirroring-on`            | the bake mirrored directions instead of rendering them                      |

A `silhouette-clipped` flag on the bottom edge is often the ground band, not lost pixels. At an
elevation the ground plane projects as a band, so a foot nearer the camera lands below the pivot row
with every vertex still at or above the ground. The flag states the contact width so you can tell a
2-pixel graze from a real cut.

**The CLI twin:** `spritebook bake`.

## 7. Stage 06 — Export

Export delivers the saved sprite bake, the canonical 3D model, or both. Sprite targets require a
bake. **3D model & textures** works before the first bake and includes the saved rig when present.

1. Select the sprite targets you want and optionally **3D model & textures**.

2. Select **Export selected**.

3. Select **Open folder** to see the files.

| Target          | What it writes                                       | Guide                                   |
| --------------- | ---------------------------------------------------- | --------------------------------------- |
| `godot`         | a Godot 4 SpriteFrames resource                      | [Godot](engines/godot.md)               |
| `texturepacker` | TexturePacker JSON Hash. Unity and Phaser read it    | [Unity](engines/unity-texturepacker.md) |
| `aseprite`      | Aseprite JSON array, with frame tags                 | [Aseprite](engines/aseprite.md)         |
| `strips`        | one horizontal strip PNG for each clip and direction | [Phaser](engines/phaser.md)             |

Sprite exporters are pure projections of one BakeManifest. The same bake writes the same bytes.
Model delivery copies `model.glb` unchanged and extracts its embedded texture bytes into separate
files, with `textures.json` recording filenames, source names and MIME types. It does not create new
animations or convert the mesh format.

New bakes keep a complete clip/direction sequence on one page. If a sequence cannot fit, reduce the
frame count or cell size. Godot and strips can also read older bakes whose animations cross pages;
Aseprite and TexturePacker refuse such split runs. Format validation is separate from importing the
files into an engine.

**The CLI twin:** `spritebook export`.

## 8. Keyboard use

Use these keyboard controls throughout the editor. Native platform accessibility qualification
remains separate from browser and component tests.

| Key                  | What it does                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| Tab, Shift+Tab       | move between controls                                                     |
| Enter, Space         | activate the focused control                                              |
| Up/Down              | move between entries in the character index; change native select values  |
| Left/Right           | move inside backend/track radio groups; resize the focused inspector grip |
| Ctrl+K               | open the command palette                                                  |
| Ctrl+M               | open **Manage extensions**                                                |
| Ctrl+Z, Ctrl+Shift+Z | undo and redo the last recorded change                                    |
| Delete               | close the focused opened character entry                                  |
| Escape               | close the palette, a dialog, or the log drawer                            |

A group of cards is one stop on the Tab path. Use the arrow keys inside it.

When a run completes, focus moves to the new content, not back to the top of the window.

## 9. When a run fails

Every command SpriteBook runs writes its output to the **session log**. Select **log** in the status
bar to open the drawer. The drawer shows each line exactly as the command wrote it. Nothing is
summarized and nothing is hidden.

1. Open the log drawer.

2. Select the **error** filter.

3. Read the last lines of the failed job.

Select **Copy** to copy the visible lines. Select **Replay previous session** to load the log of the
run before this one.

The drawer opens by itself when a journal command fails.

## 10. Undo

Each recorded change is a journal entry. Ctrl+Z reverts the last one for the active character.
Ctrl+Shift+Z applies it again. The Edit menu holds the same two commands.

Undo restores recorded decisions and the accepted canonical mesh/texture bytes for picks, rigs,
retexturing and identity edits. It also covers clip bindings and the look. It does not delete the
files a bake wrote. Review, thumbnails and implicit exports use the recorded `lastBakeId`, including
after undo; they do not guess the newest bake directory.

Permanent **Delete project** is the exception: after confirming it, undo cannot recover the removed
generated assets or editing history.

## 11. Manage extensions

Open **File > Manage extensions** (Ctrl+M). **Models** retains the model controls, **Tools** manages
optional Blender, and **Content** lists bundled packs and presets. See [extensions](extensions.md)
for tool setup, ownership and experimental quality limits. Each model shows one recommended build
for this machine; **Other versions** keeps historical builds available. Downloaded weights and
runtime readiness have separate status labels. Installation immediately shows activity, real
download bytes and the current setup phase. Dependency and native checks use an indeterminate
indicator.

Open **Details** for exact versions, terms, **Verify files**, **Repair runtime** and **Remove**. For
installed versions with a runtime recipe, **Repair runtime** runs `models setup`; confirm the action
and required license acceptance before it downloads or repairs dependencies. **Remove** deletes
downloaded model files and their receipt. Python/runtime environments and shared caches remain
separate. Generated results, accepted meshes and sprites remain in your workspace. See
[storage and removal](models.md#storage-and-removal) for a full dependency reset and the CLI twins,
including `models setup` for repairing a failed runtime installation.
