import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Phaser smoke: REAL Phaser 3 (the studio's devDependency copy) parses the
 * exported TexturePacker JSON in a REAL browser — the running desktop app's
 * WebView2, reached over CDP exactly like the walkthrough. The documented
 * consumption (docs/engines/phaser.md) is `load.atlas(png, tp.json)`; this
 * lane feeds the same parser through `textures.addAtlas` with the PNG as a
 * data URL, which runs Phaser's JSONHash parsing without a web server, and
 * asserts the frames Phaser built match the frames the JSON promised.
 *
 * Gated on SPRITEBOOK_CDP_PORT (the repo's browser-available signal) with
 * the honest-skip pattern. The page is cleaned after: the Game is destroyed
 * and window.Phaser deleted.
 */
import { assert, assertEquals } from '@std/assert';
import { createRequire } from 'node:module';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import { exportTexturePacker } from './dist/texturepacker.js';

const PORT = process.env['SPRITEBOOK_CDP_PORT'];

const BAKE = new URL('./fixtures/bake-aabbccdd', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const PHASER_JS = createRequire(import.meta.url).resolve('phaser/dist/phaser.min.js');

/** Minimal CDP evaluate client — self-contained so the lane owns its seam. */
async function cdpEval(port: number, expression: string): Promise<unknown> {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target behind the CDP port');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
    const result = await new Promise<unknown>((resolve, reject) => {
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string);
        if (m.id !== 1) return;
        if (m.error) reject(new Error(m.error.message));
        else if (m.result?.exceptionDetails) {
          reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)));
        } else resolve(m.result?.result?.value);
      };
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    return result;
  } finally {
    ws.close();
  }
}

test('phaser smoke: real Phaser parses the exported atlas in a real browser', { skip: !PORT }, async (t) => {
    const phaserSrc = await fs.readFile(PHASER_JS, 'utf8').catch(() => null);
    if (phaserSrc === null) {
      t.skip('Phaser package unavailable');
      return;
    }
    const out = await fs.mkdtemp(join(tmpdir(), 'sb-phaser-smoke-'));
    try {
      const manifest = parseWith(
        BakeManifestSchema,
        JSON.parse(await fs.readFile(`${BAKE}/manifest.json`, 'utf8')),
        'fixture BakeManifest',
      );
      await exportTexturePacker(manifest, BAKE, out, { fps: 8 });
      const json = JSON.parse(
        await fs.readFile(`${out}/${manifest.characterId}.tp.json`, 'utf8'),
      ) as { frames: Record<string, { frame: { w: number; h: number } }>; meta: { image: string } };
      const expected = Object.keys(json.frames).sort();
      const pngB64 = (await fs.readFile(`${out}/${json.meta.image}`)).toString('base64');

      const got = await cdpEval(
        Number(PORT),
        `(async () => {
          const src = ${JSON.stringify(phaserSrc)};
          (0, eval)(src);
          const img = new Image();
          img.src = 'data:image/png;base64,' + ${JSON.stringify(pngB64)};
          await img.decode();
          const game = new Phaser.Game({
            type: Phaser.HEADLESS,
            audio: { noAudio: true },
            banner: false,
          });
          try {
            // boot completes async; textures exist once the boot flag flips
            await new Promise((r) => {
              const tick = () => game.isBooted ? r() : setTimeout(tick, 20);
              tick();
            });
            game.textures.addAtlas('smoke', img, ${JSON.stringify(json)});
            const tex = game.textures.get('smoke');
            const names = tex.getFrameNames().sort();
            const f0 = tex.get(names[0]);
            return { names, w: f0.width, h: f0.height };
          } finally {
            game.destroy(true);
            delete window.Phaser;
          }
        })()`,
      ) as { names: string[]; w: number; h: number };

      assertEquals(got.names, expected, 'Phaser built exactly the frames the JSON promised');
      const first = json.frames[expected[0]!]!.frame;
      assertEquals([got.w, got.h], [first.w, first.h], 'frame geometry survives the parse');
      assert(expected.length > 0, 'the fixture has frames to parse');
      console.log(`phaser smoke: ${expected.length} frames parsed by real Phaser`);
    } finally {
      await fs.rm(out, { recursive: true }).catch(() => {});
    }
});
