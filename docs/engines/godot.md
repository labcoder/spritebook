# Godot 4 import

The `godot` target writes a Godot 4 SpriteFrames resource. This guide shows the files, the import
steps, the pivot contract, and the first faults.

## What SpriteBook writes

```
spritebook export --bake bakes/bake-<id> --out exports --targets godot
```

The files land in `exports/godot/`:

| File                   | Content                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `<characterId>.tres`   | one SpriteFrames text resource with every animation of the bake |
| `atlas_lit_<page>.png` | the lit spritesheet pages, copied unchanged from the bake       |

The `.tres` references the spritesheet pages by relative file name. It carries no `uid` line,
because Godot assigns uids on import. A multi-page bake stays in one `.tres` file.

## Import procedure

The examples below use the character id `hero`.

1. Copy `hero.tres` and each `atlas_lit_*.png` file into one folder of your Godot project.

2. Open the project.

3. Make sure the import completes with no errors and no reimport warnings.

4. Add an `AnimatedSprite2D` node to the scene.

5. In the Inspector, set the **Sprite Frames** property to `hero.tres`.

6. Make sure the SpriteFrames panel lists every animation, such as `idle_d00` to `idle_d07`.

7. Keep **Centered** on.

8. Keep **Offset** at `(0, 0)`.

9. If the bake used the `pixel` style, set the texture **Filter** to **Nearest**.

## The pivot contract

The bake records a pivot for each frame. With the default `feet-baseline` pivot, the pivot row is
world Y=0 at the bounds centre. Each `AtlasTexture` in the `.tres` carries a transparent `margin`.
The margin puts the recorded pivot at the centre of the drawn texture. An `AnimatedSprite2D` with
the default `centered = true` then puts the node origin on the pivot. Place the node at the floor
position and the character stands on it.

## Animation wiring

- The export writes one animation per clip and direction. The name is `<clipId>_d<DD>`.

- The default bake gives `idle_d00` to `idle_d07`. That is 8 directions with 6 frames of idle.

- A bake with `--clips` records each clip's fps and hold flag. The export writes them as the
  animation's `speed` and `loop`.

- A `!hold` clip gets `loop = false`. It stops on its last frame.

- If the bake recorded no clip data, the export uses the `--fps` flag. The default is 8, and the
  animation loops.

- Each frame's `duration` stays 1.0. The `speed` value carries the rate.

## Faults

**The node shows nothing, or Godot reports a broken dependency.** The `.tres` references its pages
by relative file name. A missing or renamed `atlas_lit_*.png` breaks the reference. Fix: keep the
`.tres` and the pages in one folder, with their exported names.

**The character floats or sinks.** This happens when `centered` is off. The sprite then jumps by
half of the padded texture. Fix: keep `centered` on, or set `offset` yourself. The exact `pivotPx`
for each frame is in the bake's `manifest.json`.

**The pixels look blurred.** Godot's default texture filter smooths the spritesheet. Fix: set the
texture **Filter** to **Nearest**. Then make sure no pixels from the neighbor cells show at the
sprite edges.
