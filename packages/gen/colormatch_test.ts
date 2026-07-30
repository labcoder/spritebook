/**
 * Colour-match (A2): the transfer, its compensation term, and every guard rail
 * the adversarial review demanded — each pinned to the failure it prevents.
 *
 * Synthetic glbs with known textures, so every expectation is arithmetic.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { Document, NodeIO } from '@gltf-transform/core';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import { srgbToLab } from '@spritebook/core';
import { AMBIENT } from '@spritebook/render';
import {
  CHROMA_FLOOR,
  colorMatchTexture,
  expectedMeanShade,
  L_BLEND,
  STD_RATIO_MAX,
  STD_RATIO_MIN,
} from './colormatch.ts';

/** A one-triangle glb whose baseColor texture is the given solid colour. */
async function glbWithTexture(
  path: string,
  w: number,
  h: number,
  paint: (i: number) => [number, number, number],
): Promise<void> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = paint(i);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  const tex = doc.createTexture('base')
    .setImage(encodePng({ width: w, height: h, data }))
    .setMimeType('image/png');
  const mat = doc.createMaterial('m').setBaseColorTexture(tex);
  const pos = doc.createAccessor().setType('VEC3').setBuffer(buf)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const uv = doc.createAccessor().setType('VEC2').setBuffer(buf)
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
  const prim = doc.createPrimitive().setAttribute('POSITION', pos)
    .setAttribute('TEXCOORD_0', uv).setMaterial(mat);
  doc.createScene().addChild(doc.createNode('n').setMesh(doc.createMesh().addPrimitive(prim)));
  await Deno.writeFile(path, await new NodeIO().writeBinary(doc));
}

/** An RGBA cutout image of one solid colour. */
async function cutout(path: string, rgb: [number, number, number]): Promise<void> {
  const w = 16, h = 16;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  await Deno.writeFile(path, encodePng({ width: w, height: h, data }));
}

async function textureOf(glbPath: string): Promise<Uint8Array> {
  const doc = await new NodeIO().readBinary(await Deno.readFile(glbPath));
  const img = decodePng(doc.getRoot().listTextures()[0].getImage()!);
  return img.data as Uint8Array;
}

Deno.test('the compensation term IS the rig: shade = AMBIENT + (1-AMBIENT)/4', () => {
  // Lambert's mean over a sphere of normals is exactly 1/4, so this is the
  // closed form LIGHTING-REPORT.md derives — imported from @spritebook/render
  // rather than restated, so a rig change moves this pass with it.
  assertEquals(expectedMeanShade(), AMBIENT + (1 - AMBIENT) / 4);
  assert(expectedMeanShade() > 0.4 && expectedMeanShade() < 0.6, 'sane at the shipped ambient');
});

Deno.test('a green-shifted texture moves onto a teal reference', async () => {
  // the bulma failure in miniature: the backend painted GREEN where the
  // reference is TEAL. After the match, the painted texels' mean hue must sit
  // on the reference's hue, and L must sit ABOVE the reference's L (the
  // shade-compensated target), not on it.
  const dir = await Deno.makeTempDir();
  try {
    const glb = `${dir}/m.glb`, out = `${dir}/o.glb`, img = `${dir}/ref.png`;
    await glbWithTexture(glb, 32, 32, () => [24, 106, 76]); // #186a4c, the measured hair green
    await cutout(img, [95, 214, 208]); // #5fd6d0, the reference teal

    const stats = await colorMatchTexture({ modelPath: glb, imagePath: img, outPath: out });
    assertEquals(stats.skipped, undefined, 'a colourful source is matched');
    assert(
      stats.hueDistAfter < stats.hueDistBefore / 4,
      `hue distance collapses: ${stats.hueDistBefore} -> ${stats.hueDistAfter}`,
    );

    const refLab = srgbToLab(95, 214, 208);
    const got = await textureOf(out);
    const gotLab = srgbToLab(got[0], got[1], got[2]);
    assert(
      Math.hypot(gotLab[1] - refLab[1], gotLab[2] - refLab[2]) < 0.02,
      `texel hue lands on the reference: a/b ${gotLab[1].toFixed(3)}/${gotLab[2].toFixed(3)}`,
    );
    // L aims at the BLENDED shade-compensated target (A2-LBLEND.md): full
    // compensation washed out pastels, so only L_BLEND of the lift is applied,
    // measured from the texture's own mean
    const texLab = srgbToLab(24, 106, 76);
    const compensated = Math.min(refLab[0] / Math.cbrt(expectedMeanShade()), 0.95);
    const expectedL = texLab[0] + (compensated - texLab[0]) * L_BLEND;
    assert(
      Math.abs(gotLab[0] - expectedL) < 0.03,
      `L lands on the blended target: got ${gotLab[0].toFixed(3)}, target ${
        expectedL.toFixed(3)
      } (lBlend ${L_BLEND})`,
    );
    // and the sweep harness's override reaches the maths: at 0 the L stays put
    const out0 = `${dir}/o0.glb`;
    const s0 = await colorMatchTexture({
      modelPath: glb,
      imagePath: img,
      outPath: out0,
      lBlend: 0,
    });
    assert(
      Math.abs(s0.lTarget - s0.lBefore) < 0.001,
      `lBlend 0 aims at the texture's own L: target ${s0.lTarget} vs ${s0.lBefore}`,
    );
    assert(s0.hueDistAfter < s0.hueDistBefore, 'and the hue still improves');
    // the metric this sweep exists for, seen from the LOW side: a dark L
    // cannot hold a bright source's chroma, so lBlend 0 clips on this extreme
    // fixture. Too much L clips pastels toward white; too little clips chroma
    // into the floor - the lambda sweep measures exactly this trade.
    assert(
      s0.gamutClipFraction > 0.5,
      `low-L clipping is visible to the metric: ${s0.gamutClipFraction}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a near-monochrome source SKIPS, and the texture is untouched', async () => {
  // the review's blocker-class footgun: matching to a grayscale sketch would
  // crush the texture toward grey while claiming to "match" it
  const dir = await Deno.makeTempDir();
  try {
    const glb = `${dir}/m.glb`, out = `${dir}/o.glb`, img = `${dir}/ref.png`;
    await glbWithTexture(glb, 16, 16, (i) => [200, 40 + (i % 8), 60]);
    await cutout(img, [128, 128, 128]); // pure grey: chroma 0

    const stats = await colorMatchTexture({ modelPath: glb, imagePath: img, outPath: out });
    assertEquals(stats.skipped, 'low-chroma');
    assert(stats.sourceChroma < CHROMA_FLOOR, `judged against the floor: ${stats.sourceChroma}`);
    assertEquals(
      await textureOf(out),
      await textureOf(glb),
      'the texture bytes decode identically - nothing was drained',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('UV-island filler neither contributes statistics nor gets painted', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const glb = `${dir}/m.glb`, out = `${dir}/o.glb`, img = `${dir}/ref.png`;
    // half painted red, half near-black filler
    await glbWithTexture(glb, 16, 16, (i) => (i % 2 === 0 ? [200, 30, 30] : [0, 0, 0]));
    await cutout(img, [60, 90, 220]);

    const stats = await colorMatchTexture({ modelPath: glb, imagePath: img, outPath: out });
    assertEquals(stats.paintedTexels, 128, 'exactly the painted half was measured');
    const got = await textureOf(out);
    assertEquals([got[4], got[5], got[6]], [0, 0, 0], 'filler texels stay black');
    assert(got[0] !== 200 || got[2] !== 30, 'painted texels moved');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a pathological spread ratio is clamped, and says which channels', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const glb = `${dir}/m.glb`, out = `${dir}/o.glb`, img = `${dir}/ref.png`;
    // texture with almost NO spread; a colourful reference would demand a huge
    // ratio - the clamp holds it at STD_RATIO_MAX instead of exploding noise
    await glbWithTexture(glb, 32, 32, (i) => [120, 60 + (i % 2), 200]);
    const w = 16, h = 16;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      // wildly varied colourful reference: large std on every channel
      data[i * 4] = (i * 37) % 256;
      data[i * 4 + 1] = (i * 101) % 256;
      data[i * 4 + 2] = (i * 197) % 256;
      data[i * 4 + 3] = 255;
    }
    await Deno.writeFile(img, encodePng({ width: w, height: h, data }));

    const stats = await colorMatchTexture({ modelPath: glb, imagePath: img, outPath: out });
    assert(stats.clamped.length > 0, `at least one channel hit the clamp: ${stats.clamped}`);
    assert(STD_RATIO_MIN === 0.5 && STD_RATIO_MAX === 2.0, 'the documented band');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// pick integration: ON by default, ordered before reproject, sha in the patch
// ---------------------------------------------------------------------------

Deno.test('pick colour-matches by default, pins the image sha, and one undo takes it back', async () => {
  const { appendGenerationResult, applyPatchOps, createWorkspace, readWorkspace, resultPaths } =
    await import('@spritebook/core');
  const { CharacterManifestSchema, ManifestPatchSchema, parseWith } = await import(
    '@spritebook/schema'
  );
  const { runPickJob } = await import('./mod.ts');

  const ws = await Deno.makeTempDir({ prefix: 'sb-cm-' });
  const img = `${ws}/tmp-ref.png`;
  await cutout(img, [95, 214, 208]); // teal reference
  const sha = await (async () => {
    const d = await crypto.subtle.digest(
      'SHA-256',
      (await Deno.readFile(img)) as BufferSource,
    );
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  })();
  await createWorkspace({
    workspace: ws,
    characterId: 'cm-char' as never,
    displayName: 'cm',
    source: { kind: 'image', originalFilename: 'ref.png', sha256: sha },
  });
  await Deno.mkdir(`${ws}/source`, { recursive: true });
  await Deno.rename(img, `${ws}/source/${sha}.png`);

  const receipt = {
    id: 'r1',
    backend: { modelId: 'fixture-gen', version: '1.0.0' },
    params: {},
    seed: 1,
    startedAt: '2026-07-30T00:00:00.000Z',
    wallTimeS: 1,
    output: { gltfSha256: 'a'.repeat(64), tris: 1, kind: 'mesh' as const },
    discarded: false,
  };
  await appendGenerationResult(ws, receipt);
  const rp = resultPaths(ws, 'r1');
  await Deno.mkdir(rp.dir, { recursive: true });
  await glbWithTexture(rp.model, 32, 32, () => [24, 106, 76]); // green texture

  const events: unknown[] = [];
  for await (const e of runPickJob({ jobId: 'pick', workspace: ws, resultId: 'r1' })) {
    events.push(e);
  }
  const steps = (events as Array<{ t: string; step?: string }>).filter((e) => e.t === 'progress')
    .map((e) => e.step!);
  assert(steps.some((s) => s.startsWith('color-match:')), `ran by default: ${steps}`);

  const m = parseWith(
    CharacterManifestSchema,
    JSON.parse(await Deno.readTextFile(`${ws}/character.json`)),
    'manifest',
  );
  assertEquals(m.canonicalMesh?.colorMatched, true, 'recorded in the manifest');
  assertEquals(m.canonicalMesh?.imageSha256, sha, 'the matched image is pinned');
  assert(
    m.canonicalMesh?.gltfSha256 !== 'a'.repeat(64),
    'the hash was re-pinned to the repainted bytes',
  );

  // the matched texture is really what became canonical
  const canon = await textureOf(`${ws}/canonical/model.glb`);
  assert(canon[0] !== 24 || canon[2] !== 76, 'the canonical texture is the matched one');

  // ONE journaled patch: a single undo restores the un-picked manifest whole
  const lines = (await Deno.readTextFile(`${ws}/character.json.journal.ndjson`))
    .split('\n').filter(Boolean);
  const last = parseWith(ManifestPatchSchema, JSON.parse(lines[lines.length - 1]), 'patch');
  const undone = applyPatchOps(m as never, last.inverse);
  const back = parseWith(CharacterManifestSchema, undone, 'undone');
  assertEquals(back.canonicalMesh, undefined, 'one undo pops promote+match together');

  // and --no-color-match is honoured
  const events2: unknown[] = [];
  for await (
    const e of runPickJob({ jobId: 'pick2', workspace: ws, resultId: 'r1', noColorMatch: true })
  ) {
    events2.push(e);
  }
  const steps2 = (events2 as Array<{ t: string; step?: string }>).filter((e) => e.t === 'progress')
    .map((e) => e.step!);
  assert(!steps2.some((s) => s.startsWith('color-match:')), 'the opt-out opts out');
  const m2 = parseWith(
    CharacterManifestSchema,
    JSON.parse(await Deno.readTextFile(`${ws}/character.json`)),
    'manifest2',
  );
  assertEquals(m2.canonicalMesh?.colorMatched, undefined, 'and the manifest says so');
  await Deno.remove(ws, { recursive: true });
});
