import { promises as fs } from 'node:fs';
/**
 * Build the bundled UAL animation pack (P3-T1; D-013: CC0 1.0 is what makes
 * the converted output committable) from the maintainer's local Quaternius
 * Universal Animation Library download — the PLAIN (in-place) Standard glbs,
 * not the `_RM` root-motion twins. Splits all 43+43 animations into
 * single-animation, skeleton-only clip glbs + a canonical pack.json at
 * `packages/anim/packs/ual/`.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-ffi \
 *     tools/anim/build-ual-pack.ts [--src <vendor-assets dir>]
 *
 * --src defaults to C:/dev/vendor-assets (License.txt beside each library).
 */
import { buildPack } from '../../packages/anim/dist/pack.js';
import { PACK_CLIP_DIR, PACK_MANIFEST } from '../../packages/anim/dist/contracts.js';

const here = new URL('.', import.meta.url);
const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');

let src = 'C:/dev/vendor-assets';
for (let i = 0; i < process.argv.slice(2).length; i++) {
  if (process.argv.slice(2)[i] === '--src' && process.argv.slice(2)[i + 1]) {
    src = process.argv.slice(2)[++i].replaceAll('\\', '/').replace(/\/+$/, '');
  } else {
    console.error(
      `unknown argument "${process.argv.slice(2)[i]}" — usage: build-ual-pack.ts [--src <dir>]`,
    );
    process.exit(2);
  }
}

const srcGlbs = [
  `${src}/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb`,
  `${src}/Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb`,
];
for (const glb of srcGlbs) {
  if (!(await fs.stat(glb).catch(() => undefined))?.isFile()) {
    console.error(
      `source not found: ${glb}\n(point --src at the directory holding ` +
        `"Universal Animation Library[Standard]" and "Universal Animation Library 2[Standard]")`,
    );
    process.exit(1);
  }
}

const outDir = win(new URL('../../packages/anim/packs/ual', here));
const t0 = performance.now();
const pack = await buildPack({
  srcGlbs,
  outDir,
  meta: {
    id: 'ual',
    name: 'Quaternius Universal Animation Library (free tiers)',
    version: '1+2',
    license: 'CC0-1.0',
    redistributable: true,
    source: 'https://quaternius.com - UAL 1+2 free tiers, local download',
  },
});

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------
const bytesByCategory = new Map<string, { clips: number; bytes: number }>();
let totalBytes = 0;
for (const clip of pack.clips) {
  const size = (await fs.stat(`${outDir}/${PACK_CLIP_DIR}/${clip.id}.glb`)).size;
  const row = bytesByCategory.get(clip.category) ?? { clips: 0, bytes: 0 };
  row.clips++;
  row.bytes += size;
  bytesByCategory.set(clip.category, row);
  totalBytes += size;
}
const manifestBytes = (await fs.stat(`${outDir}/${PACK_MANIFEST}`)).size;

const fmtN = (n: number) => n.toLocaleString('en-US');
console.log(
  `\npack "${pack.id}" v${pack.version} (${pack.license}) -> ${outDir}`,
);
console.log(`built in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);
console.log('category      clips        bytes');
for (const [category, row] of [...bytesByCategory.entries()].sort()) {
  console.log(
    `${category.padEnd(12)}${String(row.clips).padStart(7)}${fmtN(row.bytes).padStart(13)}`,
  );
}
console.log(
  `${'TOTAL'.padEnd(12)}${String(pack.clips.length).padStart(7)}${fmtN(totalBytes).padStart(13)}`,
);
console.log(
  `\nclips/ total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB, ${PACK_MANIFEST}: ${
    fmtN(manifestBytes)
  } B`,
);
