import { promises as fs } from 'node:fs';
/**
 * Poses-artifact READER — the render side of the P3-T1 poses seam. The FORMAT
 * is frozen in packages/anim/contracts.ts (producer): one canonical-JSON header
 * line + '\n' + a little-endian Float32 blob, frames-major
 * data[frame][joint][16] column-major LOCAL joint matrices, joints keyed by
 * NAME in the header. The writer lives in anim/sample.ts; the cross-package
 * round-trip is pinned by the parity integration test, so the two ends cannot
 * drift silently. Render deliberately does NOT import @spritebook/anim — the
 * dependency points bake -> {anim, render}, never render -> anim.
 */

export interface PosesHeader {
  clipId: string;
  frames: number;
  jointNames: string[];
  version: 1;
}

export async function readPoses(
  path: string,
): Promise<{ header: PosesHeader; data: Float32Array }> {
  const bytes = new Uint8Array(await fs.readFile(path));
  const nl = bytes.indexOf(0x0a);
  if (nl < 0) throw new Error(`${path}: not a poses file (no header line)`);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl))) as PosesHeader;
  if (header.version !== 1) {
    throw new Error(`${path}: poses version ${header.version}, expected 1`);
  }
  if (
    typeof header.clipId !== 'string' || !Array.isArray(header.jointNames) ||
    !Number.isInteger(header.frames) || header.frames < 1
  ) {
    throw new Error(`${path}: poses header is missing clipId/frames/jointNames`);
  }
  const blob = bytes.slice(nl + 1); // fresh, 4-aligned buffer
  const expected = header.frames * header.jointNames.length * 16 * 4;
  if (blob.byteLength !== expected) {
    throw new Error(`${path}: blob ${blob.byteLength} B, expected ${expected}`);
  }
  return { header, data: new Float32Array(blob.buffer, 0, expected / 4) };
}

/**
 * asset joint index -> poses joint index, matched BY NAME (-1 = no pose track;
 * the joint plays its bind local). No reporting here: in the bake pipeline the
 * poses jointNames and the render asset derive from the same model file (a
 * mismatch is unreachable), and the human-facing mapping report is emitted
 * bake-side from the retarget stage as `warn` JobEvents.
 */
export function mapPosesJoints(assetJointNames: string[], header: PosesHeader): Int32Array {
  const index = new Map(header.jointNames.map((n, i) => [n, i]));
  return Int32Array.from(assetJointNames, (n) => index.get(n) ?? -1);
}
