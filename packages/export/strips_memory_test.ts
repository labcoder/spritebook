import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';

test('strip export retains bounded decoded-page memory across many atlas pages', (t) => {
  const module = new URL('./dist/strips.js', import.meta.url).href;
  const fixture = new URL('./fixtures/bake-aabbccdd/manifest.json', import.meta.url).href;
  const child = spawnSync(process.execPath, [
    '--expose-gc',
    '--input-type=module',
    '-e',
    `
    import { promises as fs } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { encode } from '@spritebook/image';
    import { exportStrips } from ${JSON.stringify(module)};
    const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-strip-memory-'));
    try {
      const size = 1024, pages = 24;
      const rgba = new Uint8Array(size * size * 4).fill(255);
      const png = encode({width:size,height:size,data:rgba});
      const manifest = JSON.parse(await fs.readFile(new URL(${JSON.stringify(fixture)}), 'utf8'));
      const template = manifest.frames[0];
      manifest.frames = [];
      manifest.atlases = [];
      for (let i=0;i<pages;i++) {
        const name = 'atlas_lit_' + i + '.png';
        await fs.writeFile(join(root, name), png);
        manifest.atlases.push({pageIndex:i,pass:'lit',sizePx:size,png:name,layoutSharedWith:'lit'});
        manifest.frames.push({...template,direction:i,frame:0,atlas:{pageIndex:i,x:0,y:0,w:size,h:size}});
      }
      const read = fs.readFile;
      global.gc();
      const baseline = process.memoryUsage().arrayBuffers;
      let peak = 0;
      fs.readFile = async (...args) => {
        global.gc();
        peak = Math.max(peak,process.memoryUsage().arrayBuffers-baseline);
        return read(...args);
      };
      await exportStrips(manifest,root,join(root,'out'),{fps:8});
      fs.readFile = read;
      const files = await fs.readdir(join(root,'out'));
      console.log(JSON.stringify({peak,files:files.length,pages}));
    } finally { await fs.rm(root,{recursive:true,force:true}); }
  `,
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const measured = JSON.parse(child.stdout.trim());
  t.diagnostic(
    `${measured.pages} atlas pages: ${
      (measured.peak / 1024 / 1024).toFixed(1)
    } MiB peak buffer growth`,
  );
  assert.equal(measured.files, measured.pages + 1);
  // Codec/strip temporaries fit within this; retaining all 24 decoded pages alone needs 96 MiB.
  assert.ok(measured.peak < 64 * 1024 * 1024, `Decoded pages retained ${measured.peak} bytes`);
});
