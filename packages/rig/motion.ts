import type { SampledPoses } from '@spritebook/anim';
import { uniqueEdges } from './deform.ts';
import { mat4Multiply, restWorlds, type RiggedAsset, skinAll, skinMatrices } from './skin.ts';

/** Whole-surface evidence under real motion; neither anatomy nor cloth collision certification. */
export function motionSurfaceStats(asset: RiggedAsset, poses: SampledPoses) {
  if (poses.frames < 2 || poses.data.length !== poses.frames * poses.jointNames.length * 16) {
    throw new Error('Motion review needs at least two complete poses.');
  }
  const order = asset.jointNames.map((name) => {
    const index = poses.jointNames.indexOf(name);
    if (index < 0) throw new Error(`Motion review is missing joint ${name}`);
    return index;
  });
  const rest = skinAll(asset, skinMatrices(restWorlds(asset), asset.inverseBind, asset.jointCount));
  const edges = uniqueEdges(asset.indices, asset.vertexCount);
  const distance = (p: Float32Array, a: number, b: number) =>
    Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  const lengths = Float64Array.from(
    { length: edges.length / 2 },
    (_, edge) => distance(rest, edges[edge * 2], edges[edge * 2 + 1]),
  );
  const at = new Map<string, number>();
  const seams: [number, number][] = [];
  for (let vertex = 0; vertex < asset.vertexCount; vertex++) {
    const key = `${asset.positions[vertex * 3]},${asset.positions[vertex * 3 + 1]},${
      asset.positions[vertex * 3 + 2]
    }`;
    const previous = at.get(key);
    if (previous === undefined) at.set(key, vertex);
    else seams.push([previous, vertex]);
  }
  let worstStretchedFraction = 0, maxStretch = 0, maxSeparationM = 0, worstFrame = 0;
  let minY = Infinity, maxY = -Infinity;
  const worlds = new Float32Array(asset.jointCount * 16);
  let measuredEdges = 0;
  const counts = new Map<string, number>();
  for (let frame = 0; frame < poses.frames; frame++) {
    for (let joint = 0; joint < asset.jointCount; joint++) {
      const index = (frame * poses.jointNames.length + order[joint]) * 16;
      const local = poses.data.subarray(index, index + 16);
      const world = worlds.subarray(joint * 16, joint * 16 + 16);
      const parent = asset.jointParents[joint];
      if (parent < 0) world.set(local);
      else mat4Multiply(worlds.subarray(parent * 16, parent * 16 + 16), local, world);
    }
    const positions = skinAll(asset, skinMatrices(worlds, asset.inverseBind, asset.jointCount));
    for (let vertex = 0; vertex < asset.vertexCount; vertex++) {
      const y = positions[vertex * 3 + 1];
      if (
        !Number.isFinite(y) || !Number.isFinite(positions[vertex * 3]) ||
        !Number.isFinite(positions[vertex * 3 + 2])
      ) throw new Error('Motion review encountered non-finite skinning output.');
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    let stretched = 0, measured = 0;
    for (let edge = 0; edge < lengths.length; edge++) {
      if (lengths[edge] < 1e-9) continue;
      measured++;
      const a = edges[edge * 2], b = edges[edge * 2 + 1];
      const ratio = distance(positions, a, b) / lengths[edge];
      maxStretch = Math.max(maxStretch, ratio);
      if (ratio > 2) {
        stretched++;
        for (const vertex of [a, b]) {
          let slot = vertex * 4;
          for (let k = 1; k < 4; k++) {
            if (asset.weights[vertex * 4 + k] > asset.weights[slot]) slot = vertex * 4 + k;
          }
          const name = asset.jointNames[asset.joints[slot]];
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
    }
    measuredEdges = measured;
    const fraction = measured ? stretched / measured : 0;
    if (fraction > worstStretchedFraction) {
      worstStretchedFraction = fraction;
      worstFrame = frame;
    }
    for (const [a, b] of seams) {
      maxSeparationM = Math.max(maxSeparationM, distance(positions, a, b));
    }
  }
  return {
    frames: poses.frames,
    measuredEdges,
    worstStretchedFraction,
    worstFrame,
    maxStretch,
    coincidentPairs: seams.length,
    maxSeparationM,
    minY,
    maxY,
    reviewJoints: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6)
      .map(([name]) => name),
  };
}
