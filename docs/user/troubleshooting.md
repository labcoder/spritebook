# Troubleshooting

Open **log** in Studio's bottom status bar and filter for **error**. The log keeps the core
command's reason and recovery information. Copy the relevant lines when reporting a problem,
removing tokens and personal paths. CLI jobs support `--json` and `--log-append <file>`.

## A model says installed, but a job cannot start

Model weights and the Python/CUDA runtime are separate. In **File → Manage extensions → Models**,
open **Details** and use **Repair runtime**. It retains verified weights while repairing the
declared environment. **Verify files** checks model files, not whether every runtime dependency can
execute. See [model installation and repair](models.md#install-and-repair).

If a download needs DINOv3 access, request access for the declared model on Hugging Face and
authenticate before retrying. Accepting catalog terms does not grant access to a gated repository.
SpriteBook does not download missing inference dependencies silently.

## The source still has a background

Opaque images use the installed U²-Net preparation model before generation. Install `rembg-u2net` if
the error names it. An existing transparent 8-bit RGBA PNG bypasses preparation. You can inspect a
separate cutout with `spritebook prep --image ./hero.png --out ./prep`. Keep the original input; an
imperfect cutout can remove hair, fingers or fine accessories.

## The model leans or faces the wrong way

**Front**, **Side** and **Rear** only move the inspection camera. Use Rig's **Adjust alignment** to
change the model, then apply orientation and rebuild. Upright changes the body axis; grounding and
centering only change position. For an intentional lean or an uncertain upright estimate, use the
upright opt-out and inspect the result. See [Rig](guide.md#3-stage-02--rig).

## The skeleton looks correct but the surface deforms

Joint placement and skin weights describe different things. A hand resting against the leg can look
plausible at rest while pulling trouser vertices during movement. Inspect walking, jump and an
arms-raised pose. Amber bend findings name regions to inspect; blue joints only passed the sampled
tests. Rig acceptance records review and does not repair weight ownership or cloth collisions. An
authored rig remains the more predictable input for capture.

Optional Blender installation does not activate an automatic clothing fix. The current correction
trials did not justify shipping such a provider; see [extensions](extensions.md).

## Sprites clip at the cell edge

- **Left, right or top:** increase the cell dimensions or reduce pixels per metre.
- **Bottom:** increase padding, lower camera elevation or reduce pixels per metre. At an elevated
  angle the ground projects as a band below the pivot, so adding height above it may not help.
- **Model below the floor at rest:** correct grounding in Rig before capturing.

Inspect the widest and lowest animation poses. Framing only a standing idle can miss a reaching arm,
raised knee or landing pose. See [capture sizing](capture.md#compose-a-frame).

## A large render fails, or output looks smaller than expected

Output cells and antialiasing are separate. A 4096px cell at 4× supersampling asks for a 16384px
internal render and may exceed GPU texture or readback limits. Start with supersampling 1, then
increase it if the adapter permits. Raise pixels per metre alongside cell size to keep the character
large in the frame.

Contact GIFs and thumbnails are review assets. Inspect `atlas_lit_*.png`, exported strips or the
actual-pixels frame preview to judge full output resolution. Use **Original · full color** when you
want the model's appearance rather than a reduced-palette finish.

## The renderer is unavailable

Run `spritebook doctor`. It exits successfully only when an adapter exists and a small render probe
passes. Update GPU drivers if the probe fails. Windows uses the qualified Vulkan path; native
Mac/Linux desktop and GPU support remain separate qualification work.

`SPRITEBOOK_GPU_BACKEND=vulkan` selects Vulkan for a diagnostic run; `metal` selects Metal on macOS.
Linux developers can use Mesa lavapipe to exercise software rendering. Those switches do not make an
unqualified AI model/platform recipe supported.

## An export is missing frames or floats above the floor

Keep all PNG pages and metadata files together. New bakes keep complete clip/direction sequences on
a page; older bakes with split sequences may need rebaking for Aseprite/TexturePacker output. Use
the exported pivots rather than recentering slices by hand. See the [Godot](engines/godot.md),
[Unity](engines/unity-texturepacker.md), [Phaser](engines/phaser.md) and
[Aseprite](engines/aseprite.md) guides.

## Files or disk usage keep growing

Generated candidates, canonical history, motion-review drafts, bakes and exports remain in their
workspace. Undo changes the selected state; it does not reclaim all old assets. Model weights,
prepared Python runtimes and shared caches live outside projects. Removing a model preserves
character files and its runtime environments. Read [projects and files](projects.md) and
[model storage](models.md#storage-and-removal) before deleting anything.
