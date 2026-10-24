# Phaser 3 import

SpriteBook has no dedicated Phaser exporter. Phaser 3 reads the TexturePacker "JSON Hash" format
directly, so use the `texturepacker` target. The `strips` target is the alternative for your own
loader. This guide shows both.

## What SpriteBook writes

```
spritebook export --bake bakes/bake-<id> --out exports --targets texturepacker,strips
```

The files land in `exports/texturepacker/`:

| File                    | Content                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `<characterId>.tp.json` | frame rects and normalized pivots; the format carries no durations |
| `atlas_lit_<page>.png`  | the lit spritesheet pages, copied unchanged from the bake          |

And in `exports/strips/`:

| File                                     | Content                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `<characterId>-<clipId>-d<DD>-strip.png` | one horizontal strip per clip and direction                        |
| `<characterId>-strips.json`              | cell size, per-direction pivots, and each strip's `fps` and `loop` |

A multi-page bake writes one `.tp.json` per page with a `_p<pageIndex>` suffix, such as
`hero_p1.tp.json`. Animations never span pages.

## Import procedure

The examples below use the character id `hero`.

1. Copy `hero.tp.json` and `atlas_lit_0.png` into your asset folder.

2. In `preload()`, load the atlas:

   ```js
   this.load.atlas('hero', 'atlas_lit_0.png', 'hero.tp.json');
   ```

3. In `create()`, make one animation per clip and direction:

   ```js
   this.anims.create({
     key: 'idle_d00',
     frames: this.anims.generateFrameNames('hero', {
       prefix: 'idle_d00_f',
       start: 0,
       end: 5,
       zeroPad: 3,
     }),
     frameRate: 8,
     repeat: -1,
   });
   ```

4. Add the sprite with `this.add.sprite(x, floorY, 'hero')`.

5. Set the origin with `sprite.setOriginFromFrame()`.

6. Play a clip with `sprite.play('idle_d00')`.

The default idle clip has 6 frames, so `end` is 5. For the `pixel` style, set `pixelArt: true` in
the Phaser game config.

## The pivot contract

The bake records a pivot for each frame. With the default `feet-baseline` pivot, the pivot row is
world Y=0 at the bounds centre. The JSON `pivot` is that pivot divided by the cell size. X measures
from the left edge, and Y measures from the top edge. Phaser's origin uses the same convention, so
`setOriginFromFrame()` reads the pivot from the atlas JSON. Place the sprite at the floor position
and the character stands on it.

## Animation wiring

- The frame names are `<clipId>_d<DD>_f<FFF>`, as in `idle_d00_f000`.

- The format carries no durations. Set `frameRate` when you create each animation.

- Each clip's own fps is in the bake's `manifest.json` under `clips[]`. The strips JSON carries it
  too. The export default is 8.

- `repeat: -1` loops the animation. If the manifest records `loop: false` for a clip, set `repeat:
  0`. A `!hold` death clip is the usual case.

## The strips alternative

Load one strip per clip and direction as a spritesheet:

```js
this.load.spritesheet('hero-idle-d00', 'hero-idle-d00-strip.png', {
  frameWidth: 112,
  frameHeight: 112,
});
```

Read `frameWidth` and `frameHeight` from `cellPx` in `hero-strips.json`. The same JSON carries each
strip's own `fps` and `loop`. It also carries one `pivotPx` per direction. Divide `pivotPx` by the
cell size to get the `setOrigin` values. The top-level `fps` is only the default for clips without
recorded data.

## Faults

**The character floats above the floor.** Phaser's default origin is the sprite centre. Fix: call
`setOriginFromFrame()`, or call `setOrigin` with the pivot values from the JSON.

**A death clip repeats forever.** The animation was made with `repeat: -1`. Fix: read `clips[].loop`
from `manifest.json`. If it is false, set `repeat: 0`.

**Frames are missing on a multi-page bake.** Each `.tp.json` holds only its own page's frames. Fix:
load every page as its own atlas key, such as `hero_p1.tp.json` with `atlas_lit_1.png`.
