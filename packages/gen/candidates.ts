import { promises as fs } from 'node:fs';
/**
 * Candidate ranking (B2): when `gen --candidates N` makes several results in
 * one job, rank them by the quality signals the pipeline already measures, and
 * SUGGEST — the user picks, the same contract as `pick`'s multi-body advice.
 *
 * The order is lexicographic, most-disqualifying first:
 *
 *   1. connected bodies — a multi-body mesh cannot be rigged cleanly (the
 *      deform check will report tears no hint repairs), so one body beats any
 *      colour score;
 *   2. the metal fault — a majority-metal metallicRoughness poisons PBR export
 *      (invisible to the sprite renderer, real everywhere else);
 *   3. Oklab hue distance of the texture to the source image — the same
 *      statistic colour-match reports, measured without repainting anything.
 *
 * Closed services feel "always good on the first try" because they are not
 * showing you their first try; this is that mechanism, with receipts.
 */
import { NodeIO } from '@gltf-transform/core';
import { decode as decodePng } from 'fast-png';
import { srgbToLab } from '@spritebook/core';

export interface CandidateInput {
  resultId: string;
  modelPath: string;
  bodies: number;
  seed: number;
}

export interface RankedCandidate extends CandidateInput {
  metalFraction: number;
  /** Oklab a/b distance of texture mean to source mean; null when unmeasurable
   * (no texture, unreadable source) — ranked last within its tier, never
   * silently zero */
  hueDist: number | null;
}

/** Fraction of painted metallicRoughness texels whose BLUE (metallic) channel
 * exceeds 0.5 — the same reading the sidecar's gate takes, recomputed here so
 * ranking does not depend on which backend generated the mesh. */
async function metalFractionOf(modelPath: string): Promise<number> {
  try {
    const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(modelPath)));
    const mr = doc.getRoot().listMaterials()[0]?.getMetallicRoughnessTexture();
    if (!mr) return 0;
    const img = decodePng(mr.getImage()!);
    const d = img.data as Uint8Array;
    const stride = img.channels;
    let lit = 0, metal = 0;
    for (let i = 0; i < img.width * img.height; i++) {
      const r = d[i * stride], g = d[i * stride + 1], b = d[i * stride + 2];
      if (r + g + b < 0.02 * 3 * 255) continue;
      lit++;
      if (b > 128) metal++;
    }
    return lit > 0 ? metal / lit : 0;
  } catch {
    return 0;
  }
}

/** Mean Oklab of an image's subject pixels (alpha > 0.5 for RGBA sources,
 * painted texels for textures). */
function meanLab(
  d: Uint8Array,
  count: number,
  stride: number,
  keep: (i: number) => boolean,
): [number, number, number] | null {
  let n = 0;
  const mean = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    if (!keep(i)) continue;
    const lab = srgbToLab(d[i * stride], d[i * stride + 1], d[i * stride + 2]);
    n++;
    for (let c = 0; c < 3; c++) mean[c] += (lab[c] - mean[c]) / n;
  }
  return n > 0 ? (mean as [number, number, number]) : null;
}

async function hueDistOf(modelPath: string, imagePath: string): Promise<number | null> {
  try {
    const doc = await new NodeIO().readBinary(new Uint8Array(await fs.readFile(modelPath)));
    const tex = doc.getRoot().listMaterials()[0]?.getBaseColorTexture();
    if (!tex) return null;
    const t = decodePng(tex.getImage()!);
    const td = t.data as Uint8Array;
    const ts = t.channels;
    const texMean = meanLab(
      td,
      t.width * t.height,
      ts,
      (i) => td[i * ts] + td[i * ts + 1] + td[i * ts + 2] >= 0.02 * 3 * 255,
    );
    const s = decodePng(new Uint8Array(await fs.readFile(imagePath)));
    if (s.channels !== 4) return null;
    const sd = s.data as Uint8Array;
    const srcMean = meanLab(sd, s.width * s.height, 4, (i) => sd[i * 4 + 3] > 128);
    if (!texMean || !srcMean) return null;
    return Math.hypot(texMean[1] - srcMean[1], texMean[2] - srcMean[2]);
  } catch {
    return null;
  }
}

/** Measure and sort, best first. Pure ordering — nothing is discarded. */
export async function rankCandidates(
  candidates: CandidateInput[],
  sourceImagePath: string,
): Promise<RankedCandidate[]> {
  const measured: RankedCandidate[] = [];
  for (const c of candidates) {
    measured.push({
      ...c,
      metalFraction: await metalFractionOf(c.modelPath),
      hueDist: await hueDistOf(c.modelPath, sourceImagePath),
    });
  }
  return measured.sort((a, b) => {
    const bodyA = a.bodies === 1 ? 0 : 1, bodyB = b.bodies === 1 ? 0 : 1;
    if (bodyA !== bodyB) return bodyA - bodyB;
    const metalA = a.metalFraction > 0.5 ? 1 : 0, metalB = b.metalFraction > 0.5 ? 1 : 0;
    if (metalA !== metalB) return metalA - metalB;
    const hueA = a.hueDist ?? Infinity, hueB = b.hueDist ?? Infinity;
    return hueA - hueB;
  });
}

/** The advisory text, best-first with the numbers that ranked it. */
export function rankingMessage(ranked: RankedCandidate[]): string {
  const line = (r: RankedCandidate) =>
    `${r.resultId} (seed ${r.seed}: ${r.bodies} ${r.bodies === 1 ? 'body' : 'bodies'}, ` +
    `metal ${(r.metalFraction * 100).toFixed(0)}%, ` +
    `hue ${r.hueDist === null ? 'unmeasurable' : r.hueDist.toFixed(4)})`;
  const best = ranked[0];
  return `candidates ranked best-first: ${ranked.map(line).join(' > ')}. ` +
    `\`spritebook pick --result ${best.resultId}\` takes the leader; every candidate has a ` +
    `receipt and none were discarded.`;
}
