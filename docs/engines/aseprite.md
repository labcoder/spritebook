# Aseprite import

The `aseprite` target writes the Aseprite "JSON (array)" format for tools that consume Aseprite
sheets. Aseprite itself imports the PNG grid; use the JSON as the record of tags and timing when
setting up that imported sheet. See [export validation](../export-validation.md) for consumer
checks.

## What SpriteBook writes

```
spritebook export --bake bakes/bake-<id> --out exports --targets aseprite
```

The files land in `exports/aseprite/`:

| File                     | Content                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `<characterId>.ase.json` | the frame array and the frame tags for one lit spritesheet page |
| `atlas_lit_<page>.png`   | the lit spritesheet page, copied unchanged from the bake        |

The extension is `.ase.json`; the sibling `texturepacker` export uses `.tp.json`. Distinct suffixes
also keep those metadata files identifiable when copied into a common asset folder.

A bake with more than one page writes one JSON for each page, with a `_p<n>` name suffix. Each JSON
holds only the frames of its own page, and its frame tags index into that page. A tag therefore
never spans two pages.

Each frame has this name:

```
<clipId>_d<DD>_f<FFF>
```

Each clip and direction pair gets one frame tag. The tag name is `<clipId>_d<DD>`. The tag has a
`from` index, a `to` index, and `direction: "forward"`.

Each frame carries a `duration` in milliseconds. SpriteBook computes it from that clip's own `fps`
in the bake manifest. A bake with no recorded timing falls back to the `--fps` flag. The default is
8, which gives a duration of 125 ms.

CAUTION: the Aseprite JSON has no loop flag, so SpriteBook writes none. A tag's optional `repeat`
value is a play count, not a loop boolean, and writing one would be a guess. Read `clips[].loop`
from `bakes/bake-<id>/manifest.json` when you need the loop state. The `godot` and `strips` targets
carry the loop flag directly.

## Import procedure

1. Open Aseprite.

2. Select **File > Import Sprite Sheet**.

3. Select the `atlas_lit_*.png` file.

4. Set **Type** to **By Rows**.

5. Set the cell width and the cell height. The shipped default is 112 by 112 pixels; each frame's
   `frame.w` and `frame.h` in the JSON give the exact values, including non-square cells.

6. Select **Import**. Aseprite lays the cells out as frames.

7. Delete the trailing empty frames. The spritesheet page is square, so the cell grid holds more
   cells than frames. The `frames` array in the JSON gives the real count. Aseprite imports the
   empty cells as blank frames after the real ones.

8. Select **Sprite > Frame Tag Properties** to add the tags. Use the `frameTags` array under `meta`
   in the JSON for each tag's name, `from`, and `to`.

Aseprite does not read the JSON file itself on import. The JSON is the record of the frame names,
the tags, and the durations. Read it as you set the tags, or feed it to another tool.

## The pivot contract

The Aseprite JSON format carries no pivot. Aseprite has no pivot concept for an imported sheet.

The pivot is still recorded. Read `pivotPx` for each frame from `bakes/bake-<id>/manifest.json`.
With the default `feet-baseline` pivot, the pivot row is world Y=0 at the bounds centre of the
character. Place your sprite so that this pixel row sits on the floor position, and the character
stands on it.

Export the `texturepacker` target instead when your engine needs a pivot in the sheet file. That
format carries a normalized pivot for each frame.

## Animation wiring

- One tag holds one clip in one direction. A default bake has 8 directions, so one clip gives 8
  tags, such as `idle_d00` to `idle_d07`.

- Each frame's `duration` records the intended rate. Apply those durations to the imported PNG
  frames; importing the grid alone does not read the JSON timing.

- Set the loop state yourself, from `clips[].loop` in the bake manifest.

## Faults

**The frames import in the wrong order.** **Type** was not **By Rows**, or the cell size is wrong.
Fix: set **By Rows** and use the cell size from the JSON's frame rectangles. The canonical order is
clip, then direction, then frame.

**The cells are cut across two sprites.** The cell width or height does not divide the page. Fix:
read the `frame` rectangle of the first frame in the JSON. Its `w` and `h` are the exact cell size.

**The animation plays at the wrong speed.** Aseprite kept its own default frame duration. Fix: set
each frame's duration from the `duration` value in the JSON.

**An animation stops in the wrong place, or loops when it must not.** The Aseprite format has no
loop flag. Fix: read `clips[].loop` from the bake manifest and set the loop state by hand.
