/**
 * Colour-match (A2 of the quality plan): reconcile a generated texture's colour
 * statistics with the SOURCE IMAGE the character was generated from.
 *
 * Reinhard-style mean/std transfer in Oklab, texture-space — so every direction
 * and every later bake benefits, and the pass is backend-agnostic by
 * construction. Runs GPU-free and deterministic, like reproject.ts.
 *
 * ## Hue and chroma transfer directly; lightness is COMPENSATED
 *
 * The a/b channels transfer straight: the texture's hue/chroma distribution is
 * moved onto the source's. L does not, because the texture is albedo and the
 * source image is a LIT picture: the renderer will multiply the albedo by its
 * shading term, so a texture whose L already equals the source's renders darker
 * than the source by exactly that term. The target for L is therefore the
 * source's L divided (in linear terms) by the rig's expected mean shade —
 * closed-form from the rig: `AMBIENT + (1 - AMBIENT)/4`, since Lambert's mean
 * over a sphere of normals is 1/4. Oklab L is cube-root-shaped in luminance, so
 * dividing linear light by k divides L by cbrt(k). (LIGHTING-REPORT.md derives
 * the rig's term; the sweep measured texture-space dL of -0.2..-0.38 on the
 * subject that reads dark, which this is the designed fix for.)
 *
 * ## Guard rails, all default-on (the adversarial review's conditions)
 *
 * - CHROMA FLOOR: a near-monochrome source (sketch, grayscale) has ~zero chroma
 *   spread, and an unclamped std ratio would crush the texture toward
 *   monochrome while "matching" it. Below the floor the pass SKIPS and says so.
 * - STD-RATIO CLAMP: each channel's spread ratio is clamped to [0.5, 2.0], so a
 *   pathological distribution can shift colours but never explode or erase
 *   variation.
 * - Only PAINTED texels move: UV-island margins (near-black filler) neither
 *   contribute statistics nor get painted.
 */
import { NodeIO } from '@gltf-transform/core';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import { type Lab, oklabToSrgb, srgbToLab } from '@spritebook/core';
import { AMBIENT } from '@spritebook/render';

/** Below this mean chroma the source has no palette worth matching to. */
export const CHROMA_FLOOR = 0.02;
/** A channel's std ratio is clamped into this band. */
export const STD_RATIO_MIN = 0.5;
export const STD_RATIO_MAX = 2.0;
/** Texels darker than this (sum of rgb in [0,3]) are UV-island filler, not paint. */
const PAINTED_FLOOR = 0.02 * 3 * 255;

/**
 * Lambert's mean over a sphere of normals is 1/4, so a body's average shading
 * term under the rig is this. The L compensation divides by its cube root.
 */
export function expectedMeanShade(): number {
  return AMBIENT + (1 - AMBIENT) / 4;
}

export interface ColorMatchOptions {
  /** canonical glb whose baseColorTexture gets matched */
  modelPath: string;
  /** the cut-out RGBA source image (alpha marks the subject) */
  imagePath: string;
  outPath: string;
}

export interface ColorMatchStats {
  /** set when the pass declined to act; the texture is byte-identical */
  skipped?: 'low-chroma';
  /** mean chroma of the source cutout (the value judged against CHROMA_FLOOR) */
  sourceChroma: number;
  /** mean-of-means Oklab a/b distance to the source, before and after */
  hueDistBefore: number;
  hueDistAfter: number;
  /** texture mean L before/after, and the compensated target it aimed at */
  lBefore: number;
  lAfter: number;
  lTarget: number;
  /** channels whose std ratio hit the clamp (named, for the warn) */
  clamped: string[];
  paintedTexels: number;
}

interface Stats {
  mean: Lab;
  std: Lab;
  chroma: number;
  n: number;
}

function statsOf(pixels: Iterable<[number, number, number]>): Stats {
  let n = 0;
  const mean = [0, 0, 0];
  const m2 = [0, 0, 0];
  let chroma = 0;
  for (const [r, g, b] of pixels) {
    const lab = srgbToLab(r, g, b);
    n++;
    for (let c = 0; c < 3; c++) {
      const d = lab[c] - mean[c];
      mean[c] += d / n;
      m2[c] += d * (lab[c] - mean[c]);
    }
    chroma += Math.hypot(lab[1], lab[2]);
  }
  return {
    mean: mean as unknown as Lab,
    std: m2.map((v) => Math.sqrt(v / Math.max(1, n - 1))) as unknown as Lab,
    chroma: n > 0 ? chroma / n : 0,
    n,
  };
}

function* imagePixels(rgba: Uint8Array, count: number): Generator<[number, number, number]> {
  for (let i = 0; i < count; i++) {
    if (rgba[i * 4 + 3] < 128) continue;
    yield [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
  }
}

function* paintedPixels(rgba: Uint8Array, count: number): Generator<[number, number, number]> {
  for (let i = 0; i < count; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (r + g + b < PAINTED_FLOOR) continue;
    yield [r, g, b];
  }
}

/**
 * Match the model's baseColor texture to the source image. Writes `outPath`
 * (the whole glb) and returns the stats; on a skip the glb is still written,
 * byte-identically in texture terms, so callers have one code path.
 */
export async function colorMatchTexture(opts: ColorMatchOptions): Promise<ColorMatchStats> {
  const io = new NodeIO();
  const doc = await io.readBinary(await Deno.readFile(opts.modelPath));
  const material = doc.getRoot().listMaterials()[0];
  const texture = material?.getBaseColorTexture();
  if (!texture) {
    throw new Error(
      `color-match: "${opts.modelPath}" has no baseColor texture to match - a generated ` +
        `character always carries one, so this mesh did not come through \`gen\``,
    );
  }

  const img = decodePng(await Deno.readFile(opts.imagePath));
  if (img.channels !== 4) {
    throw new Error(
      `color-match: the source image must be RGBA (a cutout whose alpha marks the subject); ` +
        `"${opts.imagePath}" has ${img.channels} channels`,
    );
  }
  const src = statsOf(imagePixels(img.data as Uint8Array, img.width * img.height));

  const texPng = decodePng(texture.getImage()!);
  const texData = texPng.data as Uint8Array;
  const texCount = texPng.width * texPng.height;
  // decode may hand back RGB textures; normalise to RGBA for one paint path
  const rgba = texPng.channels === 4 ? texData : (() => {
    const out = new Uint8Array(texCount * 4);
    for (let i = 0; i < texCount; i++) {
      out[i * 4] = texData[i * 3];
      out[i * 4 + 1] = texData[i * 3 + 1];
      out[i * 4 + 2] = texData[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  })();
  const tex = statsOf(paintedPixels(rgba, texCount));

  const hueDist = (a: Stats, b: Stats) => Math.hypot(a.mean[1] - b.mean[1], a.mean[2] - b.mean[2]);
  const lComp = Math.cbrt(expectedMeanShade());
  const lTarget = Math.min(src.mean[0] / lComp, 0.95);

  const base: Omit<ColorMatchStats, 'skipped'> = {
    sourceChroma: Number(src.chroma.toFixed(4)),
    hueDistBefore: Number(hueDist(tex, src).toFixed(4)),
    hueDistAfter: Number(hueDist(tex, src).toFixed(4)),
    lBefore: Number(tex.mean[0].toFixed(4)),
    lAfter: Number(tex.mean[0].toFixed(4)),
    lTarget: Number(lTarget.toFixed(4)),
    clamped: [],
    paintedTexels: tex.n,
  };

  if (src.chroma < CHROMA_FLOOR) {
    await Deno.writeFile(opts.outPath, await io.writeBinary(doc));
    return { ...base, skipped: 'low-chroma' };
  }

  // per-channel transfer: x' = (x - texMean) * clamp(ratio) + target
  const clamped: string[] = [];
  const ratio = (c: 0 | 1 | 2, targetStd: number): number => {
    const raw = tex.std[c] > 1e-6 ? targetStd / tex.std[c] : 1;
    const r = Math.min(STD_RATIO_MAX, Math.max(STD_RATIO_MIN, raw));
    if (r !== raw) clamped.push('Lab'[c]);
    return r;
  };
  // L's spread compensates like its mean: linear scaling moves both together
  const kL = ratio(0, src.std[0] / lComp);
  const kA = ratio(1, src.std[1]);
  const kB = ratio(2, src.std[2]);

  const out = new Uint8Array(texCount * 4);
  const sums = [0, 0, 0];
  let painted = 0;
  for (let i = 0; i < texCount; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    out[i * 4 + 3] = rgba[i * 4 + 3];
    if (r + g + b < PAINTED_FLOOR) {
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      continue;
    }
    const lab = srgbToLab(r, g, b);
    const matched: Lab = [
      (lab[0] - tex.mean[0]) * kL + lTarget,
      (lab[1] - tex.mean[1]) * kA + src.mean[1],
      (lab[2] - tex.mean[2]) * kB + src.mean[2],
    ];
    const [nr, ng, nb] = oklabToSrgb(matched);
    out[i * 4] = nr;
    out[i * 4 + 1] = ng;
    out[i * 4 + 2] = nb;
    const back = srgbToLab(nr, ng, nb);
    sums[0] += back[0];
    sums[1] += back[1];
    sums[2] += back[2];
    painted++;
  }

  texture.setImage(encodePng({ width: texPng.width, height: texPng.height, data: out }))
    .setMimeType('image/png');
  await Deno.writeFile(opts.outPath, await io.writeBinary(doc));

  const afterMean: Lab = painted > 0
    ? [sums[0] / painted, sums[1] / painted, sums[2] / painted]
    : tex.mean;
  return {
    ...base,
    hueDistAfter: Number(
      Math.hypot(afterMean[1] - src.mean[1], afterMean[2] - src.mean[2]).toFixed(4),
    ),
    lAfter: Number(afterMean[0].toFixed(4)),
    clamped,
  };
}
