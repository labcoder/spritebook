# Your first spritesheet

Try the bundled authored character before downloading generation models. It includes a rig and uses
CC0 source assets. SpriteBook still needs a working GPU adapter to render frames.

## In Studio

1. Open **New character → Use a mesh or offline example** and choose the offline example.
2. In **Rig**, preview walking and jumping. Inspect the hands, shoulders and clothing before
   accepting the rig.
3. In **Animate**, enable the clips you want and set their frame counts.
4. In **Look**, choose **Side-scroller** or **Isometric**. Start with **Original · full color** to
   keep the model's materials. Aim the camera, set the output size and select **Render frame**.
5. Select **Save look & bake animations**, then **Bake sheet**. Review the frames and quality flags.
6. In **Export**, choose Godot, TexturePacker, Aseprite metadata or PNG strips. You can also export
   the canonical 3D model and its embedded textures.

The [Studio guide](guide.md) explains each stage. [Troubleshooting](troubleshooting.md) covers
failed jobs, clipped sprites and deformation problems.

## From the command line

Use the CLI included with the installed or portable app. Keep the portable runtime directory intact;
it contains the owned Node/uv executables, core, assets, production dependencies and notices.
`./spritebook` below is `./spritebook.exe` on Windows. From a source checkout, use `npm run cli --`
in place of `./spritebook`, after building.

Check the renderer and import the example into a new workspace:

```sh
./spritebook doctor
./spritebook import --workspace ./characters/hero --example --name Hero
./spritebook anim --audition --workspace ./characters/hero
```

The audition writes core-rendered walk/jump contact sheets and a motion-review report. Open the
workspace in Studio to inspect those poses. After reviewing the rig:

```sh
./spritebook rig --workspace ./characters/hero --accept
./spritebook anim --workspace ./characters/hero --enable 'walk-loop:8,jump-start:6!hold,jump-loop:6,jump-land:6!hold'
./spritebook look --workspace ./characters/hero --camera standard-30 --style clean --cell 256 --ppm 96 --padding 24
./spritebook bake --workspace ./characters/hero
./spritebook export --workspace ./characters/hero --out ./delivery/hero --targets godot,strips --mesh
```

The bake writes spritesheet pages and `manifest.json` under the workspace's selected `bakes/`
directory. The export writes Godot resources, clip/direction PNG strips and `model/model.glb` with
its embedded textures under `delivery/hero/`. Keep metadata and its referenced PNG files together.

Use `import --model ./hero.glb` instead of `--example` for an existing mesh. SpriteBook preserves
supported authored skins; static meshes still need rigging. Image generation uses `gen`, `pick` and
`rig`, with separately installed models. See the [CLI reference](cli.md) and
[model requirements](models.md).

## Choose the output

| Goal                              | Starting point                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Side-scrolling game               | Look's **Side-scroller** preset, two directions; review walking and each jump phase |
| Isometric game                    | Look's **Isometric** preset, eight directions                                       |
| Preserve the generated appearance | **Original · full color** / CLI `--style clean`                                     |
| Pixel finish                      | `--style pixel`; inspect at integer zoom with nearest-neighbor filtering            |
| High-resolution sprites           | Increase the output cell, up to 4096px; reduce antialiasing if memory is limited    |

Use the [capture and export reference](capture.md) for sizing, lighting, bakes and file formats,
then follow the [Godot](engines/godot.md), [Unity](engines/unity-texturepacker.md),
[Phaser](engines/phaser.md) or [Aseprite](engines/aseprite.md) guide.

## Preview limits

The Windows preview's automatic rigs can misassign skin weights, deform hands or let legs intersect
skirts. Rig acceptance records your review; it does not repair those defects. An authored rig gives
more predictable capture results. Check [platform support](../platform-support.md) before treating
another operating system, GPU or model recipe as supported.
