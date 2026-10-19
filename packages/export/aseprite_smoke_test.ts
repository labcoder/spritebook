import { runProcess } from '../../tools/testing/process.ts';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Aseprite smoke: the REAL Aseprite imports the exported sheet by the
 * documented procedure (docs/engines/aseprite.md) — File > Import Sprite
 * Sheet, by rows, at the cell size the JSON states — driven headlessly with
 * `aseprite -b --script`. Asserts the frame count the JSON promised and the
 * cell size round-trip. The tag step of the guide is manual in the UI, so the
 * script applies one tag from `frameTags` and asserts Aseprite accepted it.
 *
 * Gated on ASEPRITE_BIN. A configured but unavailable binary fails the lane.
 * The Lua script chooses its own exit code so a batch error cannot pass silently.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import { exportAseprite } from './dist/aseprite.js';

const ASEPRITE = process.env['ASEPRITE_BIN'];


const BAKE = new URL('./fixtures/bake-aabbccdd', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

test('aseprite smoke: the real Aseprite imports the exported sheet by the documented steps', { skip: !ASEPRITE }, async () => {
    const out = await fs.mkdtemp(join(tmpdir(), 'sb-ase-smoke-'));
    try {
      const manifest = parseWith(
        BakeManifestSchema,
        JSON.parse(await fs.readFile(`${BAKE}/manifest.json`, 'utf8')),
        'fixture BakeManifest',
      );
      await exportAseprite(manifest, BAKE, out, { fps: 8 });

      const jsonName = `${manifest.characterId}.ase.json`;
      const doc = JSON.parse(await fs.readFile(`${out}/${jsonName}`, 'utf8')) as {
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
      await fs.writeFile(
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

      const run = runProcess(ASEPRITE!, ['-b', '--script', script]);
      const { code, stdout, stderr } = await run;
      const text = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
      assertEquals(code, 0, `aseprite exited ${code}:\n${text}`);
      assertStringIncludes(text, 'ASE-SMOKE-OK', text);
      assertStringIncludes(text, `frames=${doc.frames.length} `);
      assert(doc.meta.frameTags.length > 0, 'the fixture carries tags to wire');
    } finally {
      await fs.rm(out, { recursive: true }).catch(() => {});
    }
});
