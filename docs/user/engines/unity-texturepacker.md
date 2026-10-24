# Unity import, through TexturePacker

Unity has no dedicated SpriteBook exporter. Use the `texturepacker` target. It writes the "JSON
Hash" format. The TexturePacker Importer for Unity reads that format.

The native Unity/importer lane remains unverified in the current migration evidence. Follow
[export validation](../../developer/export-validation.md) to run it with your editor and importer
before relying on a release's Unity support claim.

## What SpriteBook writes

```
spritebook export --bake bakes/bake-<id> --out exports --targets texturepacker
```

The files land in `exports/texturepacker/`:

| File                    | Content                                                  |
| ----------------------- | -------------------------------------------------------- |
| `<characterId>.tp.json` | the frame hash for one lit spritesheet page              |
| `atlas_lit_<page>.png`  | the lit spritesheet page, copied unchanged from the bake |

The extension is `.tp.json`; the sibling `aseprite` export uses `.ase.json`. Distinct suffixes keep
the formats identifiable when copied into a common asset folder.

A bake with more than one page writes one JSON for each page. The extra pages get a `_p<n>` name
suffix, such as `<characterId>_p1.tp.json`. Each JSON holds only the frames of its own page. An
animation therefore never spans two pages.

Each frame in the hash has this key:

```
<clipId>_d<DD>_f<FFF>
```

`<DD>` is the direction, from `00`. `<FFF>` is the frame number, from `000`.

Cells are packed as full rectangles. There is no trim and no rotation. Each frame therefore has
`trimmed: false`, `rotated: false`, and a `sourceSize` equal to the cell size.

## Import procedure

You need a user-supplied TexturePacker Importer package for Unity. SpriteBook does not bundle it.

1. Install the TexturePacker Importer package in your Unity project.

2. Rename `<characterId>.tp.json` to `<characterId>.json`. The Unity importer looks for a `.json`
   file beside the PNG. The JSON's `meta.image` field names the PNG, so the two files link by that
   field, not by a shared base name.

3. Copy the renamed JSON and the `atlas_lit_*.png` file into your `Assets` folder. Put both files in
   one folder.

4. Select the PNG in the Project window.

5. In the Inspector, set **Texture Type** to **Sprite (2D and UI)**.

6. Set **Sprite Mode** to **Multiple**.

7. If the bake used the `pixel` style, set **Filter Mode** to **Point (no filter)** and set
   **Compression** to **None**.

8. Select **Apply**. The importer cuts the sprites and names each one after its frame key.

9. Make sure the Project window lists the sprites under the PNG.

## The pivot contract

The `texturepacker` target writes a `pivot` for each frame. The pivot is normalized: SpriteBook
divides `pivotPx` by the cell size, so both values are between 0 and 1. The TexturePacker Importer
applies this pivot to each cut sprite.

With the default `feet-baseline` pivot, the pivot is world Y=0 at the bounds centre of the
character. Put the GameObject at the floor position, and the character stands on it.

CAUTION: Unity's own Sprite Editor can overwrite the pivot. If you cut the sheet by hand, or if you
select a **Pivot** value in the Sprite Editor, the imported pivot is lost. The sprite then sits at
the wrong height and the character sinks or floats.

## Animation wiring

The JSON Hash format carries no frame durations. Timing belongs to the consumer. SpriteBook records
the rate in the bake manifest, not in this file.

1. Select the sprites of one clip and one direction, in frame order. The frame key sorts them.

2. Drag them into the Scene view. Unity makes an Animation Clip and an Animator Controller.

3. Open the **Animation** window and set the sample rate. Use the `fps` value from
   `bakes/bake-<id>/manifest.json`, in the `clips` array. The bake default is 8.

4. Do steps 1 to 3 for each direction. A default bake has 8 directions.

5. In the Animator, add a parameter for the direction. Use it to select the clip.

## Faults

**The sprites import as one image.** **Sprite Mode** is still **Single**, or the JSON is not beside
the PNG. Fix: set **Sprite Mode** to **Multiple**, and put both files in one folder. The JSON's
`meta.image` field must name the PNG file exactly.

**The character sinks into the floor, or floats above it.** The pivot was overwritten in the Sprite
Editor. Fix: delete the sprite metadata and import again. Do not open the Sprite Editor. The exact
`pivotPx` for each frame is in the bake's `manifest.json`.

**The pixels look blurred, or the sprite edges show colour from the next cell.** Unity filtered and
compressed the spritesheet. Fix: set **Filter Mode** to **Point (no filter)** and **Compression** to
**None**.

**One animation is missing frames.** The bake made more than one page, and you imported only the
first JSON. Fix: import each `_p<n>` file. Each page holds complete animations, so no animation is
split between two files.
