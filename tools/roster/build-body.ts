import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Build the bundled canonical Track A bodies from the maintainer's Quaternius
 * Universal Base Characters download (CC0 1.0, verified 2026-07-20 —
 * License_Standard.txt in the download states it explicitly).
 *
 *   node tools/run.mjs tools/roster/build-body.ts [--src <ubc dir>] [--out <bodies dir>]
 *
 * Two upstream defects are repaired IN A STAGING COPY, never in the download:
 *
 * 1. Broken texture URIs. The exports reference `T_Hair_1_Normal_png.png` and
 *    `T_Eye_Normal_png.png`; the shipped files drop the `_png` suffix. The
 *    stage step copies each existing texture under BOTH names so the glTF
 *    resolves without editing it.
 * 2. .gltf + external files -> one self-contained glb, because
 *    buildCanonicalBody (and everything downstream) speaks single-file glbs —
 *    a bundled body that referenced loose PNGs would break the moment it was
 *    copied anywhere.
 *
 * Output layout (fmt-excluded, committed):
 *   packages/rig/bodies/ubc-male/body.glb + body.json
 *   packages/rig/bodies/ubc-female/body.glb + body.json
 */
import { NodeIO } from '@gltf-transform/core';
import { prune, textureCompress } from '@gltf-transform/functions';
import { buildCanonicalBody } from '../../packages/rig/dist/fit.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  const v = i < 0 ? undefined : args[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
};

const srcRoot = flag('src') ??
  'C:/dev/vendor-assets/Universal Base Characters[Standard]/Base Characters/Godot - UE';
const outRoot = flag('out') ?? decodeURIComponent(
  new URL('../../packages/rig/bodies', import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    '$1',
  ),
);

const BODIES = [
  {
    file: 'Superhero_Male_FullBody',
    id: 'ubc-male',
    displayName: 'UBC Superhero (male build)',
  },
  {
    file: 'Superhero_Female_FullBody',
    id: 'ubc-female',
    displayName: 'UBC Superhero (female build)',
  },
] as const;

// stage: copy gltf+bin+textures, adding the `_png.png` aliases the exports ask for
const stage = await fs.mkdtemp(join(tmpdir(), 'ubc-stage-'));
for await (const entry of await fs.readdir(srcRoot, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  await fs.copyFile(`${srcRoot}/${entry.name}`, `${stage}/${entry.name}`);
  if (entry.name.endsWith('.png') && !entry.name.endsWith('_png.png')) {
    const alias = entry.name.replace(/\.png$/, '_png.png');
    await fs.copyFile(`${srcRoot}/${entry.name}`, `${stage}/${alias}`);
  }
}

const io = new NodeIO();
for (const body of BODIES) {
  // consolidate to one glb (textures embedded) in the staging dir.
  // PRUNE first: the exports carry hair/eye textures no FullBody mesh
  // references, and embedding those turned a ~1.7 MB body into ~15 MB.
  // RESIZE second: the source ships 4K normal/roughness maps, but a canonical
  // body exists to be baked at <=128 px and previewed in a small viewport -
  // 1K keeps everything visible at those scales at a quarter of the bytes.
  const doc = await io.read(`${stage}/${body.file}.gltf`);
  await doc.transform(
    prune(),
    textureCompress({ targetFormat: 'png', resize: [1024, 1024] }),
  );
  // DROP every map the pipeline never reads. The renderer samples base color
  // only (packages/render/shaders.wgsl), so normal/roughness/occlusion/
  // emissive maps are ~4.4 MB per body of texels nothing looks at - and every
  // fitted character inherits a copy of them, so a 10-character roster stores
  // ten copies. Re-add here the day a map becomes an input to the AOV pass.
  for (const material of doc.getRoot().listMaterials()) {
    material.setNormalTexture(null)
      .setMetallicRoughnessTexture(null)
      .setOcclusionTexture(null)
      .setEmissiveTexture(null);
  }
  await doc.transform(prune());
  const glbPath = `${stage}/${body.file}.glb`;
  await fs.writeFile(glbPath, await io.writeBinary(doc));

  const outDir = `${outRoot}/${body.id}`;
  await fs.mkdir(outDir, { recursive: true });
  const result = await buildCanonicalBody({
    sourcePath: glbPath,
    outDir,
    id: body.id,
    displayName: body.displayName,
    license: 'CC0-1.0',
    source: 'https://quaternius.com - Universal Base Characters (standard/free tier), ' +
      'local download, License_Standard.txt states CC0 1.0',
  });
  console.log(
    `${body.id}: ${result.body.jointCount} joints, ${result.body.vertexCount} verts, ` +
      `${result.body.heightM.toFixed(3)} m, ${result.body.regions.length} regions -> ${outDir}`,
  );
}

await fs.rm(stage, { recursive: true });
console.log('done - staging cleaned; the download itself was never touched');
