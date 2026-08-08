/**
 * Aseprite smoke: the REAL Aseprite imports the exported sheet by the
 * documented procedure (docs/engines/aseprite.md) — File > Import Sprite
 * Sheet, by rows, at the cell size the JSON states — driven headlessly with
 * `aseprite -b --script`. Asserts the frame count the JSON promised and the
 * cell size round-trip. The tag step of the guide is manual in the UI, so the
 * script applies one tag from `frameTags` and asserts Aseprite accepted it.
 *
 * Gated like the Godot lane: `ignore` without ASEPRITE_BIN, and a
 * skip-that-says-so when the run permission is missing (`deno task
 * test:aseprite` grants it). The Godot lesson is carried over: the Lua script
 * chooses its own exit code, because a raised error in batch mode must never
 * become a hang or a hollow green.
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import { exportAseprite } from './aseprite.ts';

const ASEPRITE = Deno.env.get('ASEPRITE_BIN');

async function canRun(bin: string): Promise<boolean> {
  const { state } = await Deno.permissions.query({ name: 'run', command: bin });
  return state === 'granted';
}

const BAKE = new URL('./fixtures/bake-aabbccdd', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

Deno.test({
  name: 'aseprite smoke: the real Aseprite imports the exported sheet by the documented steps',
  ignore: !ASEPRITE,
  fn: async () => {
    if (!(await canRun(ASEPRITE!))) {
      console.log(
        'skip: ASEPRITE_BIN is set but this run cannot spawn it - asserted NOTHING. ' +
          'Use `deno task test:aseprite`, which grants --allow-run.',
      );
      return;
    }
    const out = await Deno.makeTempDir({ prefix: 'sb-ase-smoke-' });
    try {
      const manifest = parseWith(
        BakeManifestSchema,
        JSON.parse(await Deno.readTextFile(`${BAKE}/manifest.json`)),
        'fixture BakeManifest',
      );
      await exportAseprite(manifest, BAKE, out, { fps: 8 });

      const jsonName = `${manifest.characterId}.ase.json`;
      const doc = JSON.parse(await Deno.readTextFile(`${out}/${jsonName}`)) as {
        frames: { frame: { w: number; h: number } }[];
        meta: { image: string; frameTags: { name: string; from: number; to: number }[] };
      };
      const cell = doc.frames[0]!.frame;
      const tag = doc.meta.frameTags[0]!;

      // The DOCUMENTED import, headless: by rows at the JSON's cell size,
      // then delete the trailing empty cells (the atlas page is square, so
      // the grid holds more cells than frames - this lane's first real run
      // caught the guide missing that step). An uncaught Lua error makes
      // aseprite -b exit -1 promptly (os.exit is unsupported in its
      // sandbox), so failure needs no exit-code plumbing.
      const script = `${out}/smoke.lua`;
      await Deno.writeTextFile(
        script,
        [
          `local sprite = app.open("${out.replaceAll('\\', '/')}/${doc.meta.image}")`,
          `assert(sprite, "the exported png did not open")`,
          `app.command.ImportSpriteSheet{`,
          `  ui=false,`,
          `  type=SpriteSheetType.ROWS,`,
          `  frameBounds=Rectangle(0, 0, ${cell.w}, ${cell.h}),`,
          `}`,
          `local grid = #app.sprite.frames`,
          `assert(grid >= ${doc.frames.length},`,
          `  "grid cells: got " .. grid .. ", fewer than the ${doc.frames.length} frames promised")`,
          // the guide's new step: frames past the JSON's count are empty grid
          `while #app.sprite.frames > ${doc.frames.length} do`,
          `  app.sprite:deleteFrame(#app.sprite.frames)`,
          `end`,
          `assert(#app.sprite.frames == ${doc.frames.length}, "trim did not land")`,
          `local t = app.sprite:newTag(${tag.from + 1}, ${tag.to + 1})`,
          `t.name = "${tag.name}"`,
          `assert(#app.sprite.tags == 1, "the tag was not accepted")`,
          `print("ASE-SMOKE-OK frames=" .. #app.sprite.frames .. " grid=" .. grid)`,
        ].join('\n'),
      );

      const run = new Deno.Command(ASEPRITE!, {
        args: ['-b', '--script', script],
        stdout: 'piped',
        stderr: 'piped',
      });
      const { code, stdout, stderr } = await run.output();
      const text = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
      assertEquals(code, 0, `aseprite exited ${code}:\n${text}`);
      assertStringIncludes(text, 'ASE-SMOKE-OK', text);
      assertStringIncludes(text, `frames=${doc.frames.length} `);
      assert(doc.meta.frameTags.length > 0, 'the fixture carries tags to wire');
    } finally {
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
});
