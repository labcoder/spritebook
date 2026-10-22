# SpriteBook Studio user guide

Studio on main now uses the owned Node runtime. Build a local Windows candidate with `npm run
build:desktop`; see [development setup](../README.md#development) and the
[qualification status](../future/runtime-cutover.md). Published/signed target artifacts remain F7
work. Every action below has a CLI twin — see [the CLI reference](cli.md).

SpriteBook turns a character image into engine-ready 2D spritesheets. It runs on your machine.
Nothing goes to a server.

Studio is the guided editor. It has six stages, from the source image to the exported files. Each
stage wraps a command of the SpriteBook CLI. The CLI does everything Studio does, and each primary
button shows the exact command it runs. To work in the terminal instead, read
[the quickstart](quickstart.md).

This guide is about the app. Read the quickstart first if you want the shortest path to a
spritesheet.

The gallery and Look images show the current production browser-demo UI with synthetic data; the
colored demo frames illustrate controls, not generated character output. See the
[dark theme](img/stage-04-look-dark.png) as well.

## 1. Open a project

![The gallery](img/gallery.png)

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
every line the CLI writes).

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
   [licensing](licensing.md) and accept the declared terms before installation. The selected Windows
   runtimes replace the historical evaluation-only rasterizers; component terms still apply.
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
**Manage models**. Transparent 8-bit RGBA PNGs pass through unchanged. Preparation appears in the
job progress and runs once for the candidate batch; retries reuse the verified cutout. Your original
reference is retained, and preparation is recorded as an undoable source edit.

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

There are two tracks:

- **Track A — canonical body fit.** SpriteBook fits a bundled body to your mesh. Use this for a
  humanoid character. It is fast and it needs no model download.
- **Track B — predicted skeleton.** The UniRig model predicts a skeleton. Use this when the
  character is not a standard humanoid.

To rig a character:

1. Select the track. Use the arrow keys to move between the two cards.

2. For Track A, keep `ubc-male` for the portable bundled default, or enter an explicit body
   directory. The bundled `ubc-female` is available by its directory path; its name is not a
   portable CLI alias.

3. Select **Run rig**.

The mesh stays on the left and the rig controls stay on the right. The **Deform check** section
beneath the mesh reports the result. It shows the worst tear first and states how many joints are
clean.

Six orientation buttons fix a mesh that faces the wrong way: **Face front**, **Feet to ground**,
**Center**, and **Rotate 90**, **Rotate 180**, **Rotate 270**. Each one runs the rig again.

**Accept rig** records that you looked at the report and the result is good. Acceptance is your act,
not a default. A bake with an unaccepted rig raises a warning but still runs.

CAUTION: acceptance costs nothing to record, but a rig you never checked can produce bad skinning in
every frame of every clip. Read the deform report before you accept.

To repair a rig, use **Auto-hint from this report and re-run**, or open **Joint edits file** to
supply a patch.

**The CLI twin:** `spritebook rig`.

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

![Stage 04 - Look](img/stage-04-look.png)

Look sets the camera and the art style. It is the stage that decides what the sprites look like.

The camera controls are:

| Control               | What it does                                                       |
| --------------------- | ------------------------------------------------------------------ |
| **Camera**            | selects a camera preset, such as `standard-30`                     |
| **Elevation**         | the camera angle above the ground, in degrees                      |
| **Directions**        | how many directions to bake: 2, 4, 8, or 16                        |
| **Pixels per metre**  | the world-locked ruler. The whole roster shares it                 |
| **Cell width/height** | the size of one sprite cell, in pixels. The shipped default is 112 |

The main recipe row contains camera, direction count, cell size, style, colour count and outline.
Open **Camera and style details** for elevation, its detent buttons and pixels per metre. The
elevation slider moves 0.5 degrees for each arrow key press. The selected style also states its mode
and supersampling there.

The comparison shows the original source image beside sprites from the saved bake. Select a
**Clip**, then **Play** or **Pause**. The displayed directions share one playback clock. Zoom is
nearest-neighbor at 1×, 2×, 4× or 6×; large cells scroll within the dark well. This preview
currently shows the first atlas page, as labeled. Bake retains its full review controls.

The right-hand inspector is headed by the character name and reaches from the stage rail to the
bottom. Drag its boundary to resize, or focus the grip and use Left/Right, Home/End; double-click
resets to 360px. Its chevron collapses/reopens the panel without losing draft settings or stopping
jobs. Width persists locally (280–560px). This layout applies to every stage; assets and candidate
choices remain on the left.

CAUTION: every frame key holds the whole recipe, so a look change makes every baked frame stale. The
stage states the exact frame count before you record. This is all-or-none: there is no partial
re-bake after a look change.

Select **Record look** to save the change. Select **Reset to recorded** to drop it.

**The CLI twin:** `spritebook look`.

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
  the same layout as the lit page.

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

Export writes the files your engine reads. One bake can feed every target.

1. Select the targets you want.

2. Select **Export selected**.

3. Select **Open folder** to see the files.

| Target          | What it writes                                       | Guide                                   |
| --------------- | ---------------------------------------------------- | --------------------------------------- |
| `godot`         | a Godot 4 SpriteFrames resource                      | [Godot](engines/godot.md)               |
| `texturepacker` | TexturePacker JSON Hash. Unity and Phaser read it    | [Unity](engines/unity-texturepacker.md) |
| `aseprite`      | Aseprite JSON array, with frame tags                 | [Aseprite](engines/aseprite.md)         |
| `strips`        | one horizontal strip PNG for each clip and direction | [Phaser](engines/phaser.md)             |

The exporters are pure projections of one bake manifest. The same bake always writes the same bytes.

**The CLI twin:** `spritebook export`.

## 8. Keyboard use

Every control is reachable with the keyboard alone. The full journey was driven this way, and a test
holds it there.

| Key                  | What it does                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| Tab, Shift+Tab       | move between controls                                                     |
| Enter, Space         | activate the focused control                                              |
| Up/Down              | move between entries in the character index; change native select values  |
| Left/Right           | move inside backend/track radio groups; resize the focused inspector grip |
| Ctrl+K               | open the command palette                                                  |
| Ctrl+M               | open **Manage models**                                                    |
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

## 11. Manage or remove models

Open **File > Manage models** (Ctrl+M). Each model shows one recommended build for this machine;
**Other versions** keeps historical builds available. Downloaded weights and runtime readiness have
separate status labels. Installation immediately shows activity, real download bytes and the current
setup phase. Dependency and native checks use an indeterminate indicator.

Open **Details** for exact versions, terms, **Verify files**, **Repair runtime** and **Remove**. For
installed versions with a runtime recipe, **Repair runtime** runs `models setup`; confirm the action
and required license acceptance before it downloads or repairs dependencies. **Remove** deletes
downloaded model files and their receipt. Python/runtime environments and shared caches remain
separate. Generated results, accepted meshes and sprites remain in your workspace. See
[storage and removal](models.md#storage-and-removal) for a full dependency reset and the CLI twins,
including `models setup` for repairing a failed runtime installation.
