/**
 * Orientation detection and the tier-2 structural repairs (P3-T3).
 *
 * SpriteBook's canonical convention is +Z facing, +Y up, feet at Y=0 (D-012).
 * A mesh that arrives facing elsewhere is the nastiest class of import bug
 * because NOTHING fails: the rig succeeds, the bake succeeds, and every one of
 * the eight directions is silently wrong — the character walks sideways in a
 * sheet nobody re-checks until it is in a game. So the facing check runs on
 * rig entry, and it SUGGESTS rather than applies: a user may have imported
 * something deliberately odd, and silently rotating their asset is its own
 * betrayal.
 *
 * ## How facing is measured
 *
 * From the geometry alone, using two signals that agree for humanoids and
 * degrade honestly for everything else:
 *
 * 1. **Silhouette width.** Humanoids are wider across the shoulders than they
 *    are deep through the chest. Whichever horizontal axis is WIDER is the
 *    left-right axis, which leaves the other as the facing axis and halves
 *    the answer space before anything has to pick a sign.
 * 2. **Reach from the mass centroid.** A person is not front/back symmetric:
 *    toes protrude forward much further than heels protrude back. So the sign
 *    comes from which side reaches FURTHER from the centre of mass, measured
 *    hardest over the bottom slice of the mesh where the feet are.
 *
 * Confidence multiplies the two: it needs both a clearly non-square body AND a
 * clear asymmetry, so a barrel (no meaningful facing) reports ~0 and the
 * caller can decline to act rather than rotating something arbitrarily.
 */
import { Document, type Node, NodeIO } from '@gltf-transform/core';
import type { FacingReport, OrientationFix } from '@spritebook/schema';

/** Every position in the document, in world space, as a flat XYZ array. */
export function worldPositions(doc: Document): Float32Array {
  const out: number[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const arr = pos.getArray()!;
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2];
        // column-major 4x4 * (x,y,z,1)
        out.push(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        );
      }
    }
  }
  return Float32Array.from(out);
}

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function boundsOf(p: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = p[i + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

/**
 * Which way does this geometry face? Pure measurement over world positions —
 * no skeleton required, so it works before OR after rigging.
 */
export function detectFacing(positions: Float32Array): FacingReport {
  const n = positions.length / 3;
  if (n < 8) {
    return {
      facing: 'unknown',
      confidence: 0,
      evidence: { vertices: n },
    };
  }
  const b = boundsOf(positions);
  const width = b.max[0] - b.min[0]; // X extent
  const depth = b.max[2] - b.min[2]; // Z extent
  const height = b.max[1] - b.min[1];
  if (!(height > 0) || !(width > 0) || !(depth > 0)) {
    return { facing: 'unknown', confidence: 0, evidence: { width, depth, height } };
  }

  // 1. the wider horizontal axis is left-right, so the OTHER one is facing
  const facingAxis: 0 | 2 = width >= depth ? 2 : 0;
  const lateralExtent = facingAxis === 2 ? width : depth;
  const facingExtent = facingAxis === 2 ? depth : width;
  // 0 when the cross-section is square (a barrel: no opinion), ->1 when the
  // body is clearly flatter one way than the other
  const shapeConfidence = Math.min(
    1,
    (lateralExtent - facingExtent) / Math.max(1e-6, facingExtent),
  );

  // 2. sign from REACH about the mass centroid, not the bounding-box middle.
  // The bbox middle is the wrong reference precisely because of the cue we
  // care about: protruding toes drag the middle forward, which then makes the
  // whole rest of the body measure as "behind" it and inverts the answer
  // (caught by the humanoid fixture — it read -Z). Measuring how much FURTHER
  // one side reaches from the centre of mass isolates the protrusion itself.
  const skew = (
    slice: (i: number) => boolean,
  ): { bias: number; count: number } => {
    let sum = 0, count = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      if (!slice(i)) continue;
      const v = positions[i + facingAxis];
      sum += v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      count++;
    }
    if (count === 0 || !(hi > lo)) return { bias: 0, count };
    const centroid = sum / count;
    // > 0 when the +axis side protrudes further from the mass centre
    return { bias: ((hi - centroid) - (centroid - lo)) / (hi - lo), count };
  };

  const footCut = b.min[1] + height * 0.15;
  const body = skew(() => true);
  const feet = skew((i) => positions[i + 1] <= footCut);
  const bodyBias = body.bias;
  const footBias = feet.bias;
  const footCount = feet.count;
  // feet lead when we have them, but the body still votes: a character
  // carrying something in front would otherwise outvote its own toes
  const bias = footCount > 0 ? footBias * 0.6 + bodyBias * 0.4 : bodyBias;

  const positive = bias >= 0;
  const facing: FacingReport['facing'] = facingAxis === 2
    ? (positive ? '+Z' : '-Z')
    : (positive ? '+X' : '-X');
  // confidence needs BOTH a clear body shape and a clear asymmetry
  const confidence = Math.max(0, Math.min(1, shapeConfidence * Math.min(1, Math.abs(bias) * 4)));

  const evidence = {
    width,
    depth,
    height,
    facingAxis,
    bodyBias: Number(bodyBias.toFixed(6)),
    footBias: Number(footBias.toFixed(6)),
    footVertices: footCount,
    shapeConfidence: Number(shapeConfidence.toFixed(6)),
  };

  if (facing === '+Z') return { facing, confidence, evidence };
  return { facing, confidence, suggestedFix: fixFor(facing), evidence };
}

/** The single verb that turns `facing` into the canonical +Z. */
export function fixFor(facing: FacingReport['facing']): OrientationFix | undefined {
  switch (facing) {
    case '-Z':
      return 'rotate-180';
    case '+X':
      return 'rotate-90';
    case '-X':
      return 'rotate-270';
    default:
      return undefined;
  }
}

/** Detect facing straight from a glb on disk. */
export async function detectFacingFile(path: string): Promise<FacingReport> {
  const doc = await new NodeIO().readBinary(await Deno.readFile(path));
  return detectFacing(worldPositions(doc));
}

// ---------------------------------------------------------------------------
// Tier-2 repairs
// ---------------------------------------------------------------------------

/** Yaw rotation about +Y, in degrees, as a column-major 4x4. */
function yawMatrix(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  // column-major: rotating +Z toward +X for positive angles
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function mul(a: number[], b: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = v;
    }
  }
  return out;
}

/**
 * Flatten every mesh node's transform into its vertex data, leaving the nodes
 * at identity.
 *
 * Orientation fixes compose as node matrices, which is the natural way to write
 * them — and it used to be where they STOPPED. A glTF skinned mesh ignores its
 * node's transform (the joints place it), so `rig --feet-ground` wrote a
 * translation onto a mesh that was about to be skinned and the translation
 * silently evaporated: measured, a body 1 m below the ground plane got a node
 * matrix of +1 and vertices still at -1. Baking is what makes a fix real.
 *
 * Every fix here is a yaw rotation and/or a translation — rigid and orthonormal
 * — so NORMAL and TANGENT take the rotation directly, without the
 * inverse-transpose a non-uniform scale would need, and their lengths survive.
 * TANGENT.w is handedness, not geometry, so it is copied through.
 */
function bakeNodeTransforms(doc: Document): void {
  const meshNodes = doc.getRoot().listNodes().filter((n) => n.getMesh() !== null);

  // Accessors can be SHARED between primitives and between meshes. Transforming
  // one twice composes the fix with itself; transforming one that two nodes
  // place differently has no right answer at all. The importer hit the first
  // half of this and deduped; the second half is refused, loudly, because
  // producing a plausible wrong mesh is the worse failure.
  const owner = new Map<unknown, string>();
  for (const node of meshNodes) {
    const key = node.getWorldMatrix().join(',');
    for (const prim of node.getMesh()!.listPrimitives()) {
      for (const name of ['POSITION', 'NORMAL', 'TANGENT'] as const) {
        const acc = prim.getAttribute(name);
        if (!acc) continue;
        const seen = owner.get(acc);
        if (seen !== undefined && seen !== key) {
          throw new Error(
            `applyOrientationFixes: ${name} data is shared by mesh nodes placed differently, ` +
              `so no single baked transform is correct for it. Split the mesh before orienting it.`,
          );
        }
        owner.set(acc, key);
      }
    }
  }

  const done = new Set<unknown>();
  for (const node of meshNodes) {
    const m = [...node.getWorldMatrix()];
    for (const prim of node.getMesh()!.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (pos && !done.has(pos)) {
        done.add(pos);
        const a = pos.getArray() as Float32Array<ArrayBuffer>;
        for (let i = 0; i < a.length; i += 3) {
          const x = a[i], y = a[i + 1], z = a[i + 2];
          a[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
          a[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          a[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        pos.setArray(a);
      }
      // direction vectors: rotation only, so no translation column
      for (const name of ['NORMAL', 'TANGENT'] as const) {
        const acc = prim.getAttribute(name);
        if (!acc || done.has(acc)) continue;
        done.add(acc);
        const a = acc.getArray() as Float32Array<ArrayBuffer>;
        const stride = acc.getElementSize();
        for (let i = 0; i < a.length; i += stride) {
          const x = a[i], y = a[i + 1], z = a[i + 2];
          a[i] = m[0] * x + m[4] * y + m[8] * z;
          a[i + 1] = m[1] * x + m[5] * y + m[9] * z;
          a[i + 2] = m[2] * x + m[6] * y + m[10] * z;
        }
        acc.setArray(a);
      }
    }
  }

  // the transform now lives in the data, so leaving it on the nodes too would
  // apply it twice to anything that reads them
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const node of meshNodes) {
    for (let n: Node | null = node; n !== null; n = n.getParentNode()) {
      n.setMatrix(identity as never);
    }
  }
}

/**
 * Apply structural fixes, composing them as node transforms and then BAKING the
 * result into the vertex data. Fixes compose in the order given and are
 * recorded in `RigState.orientationFixes` by the caller.
 *
 * The bake is not an optimization. These fixes run on the canonical mesh
 * immediately before it is rigged, and a skinned mesh node's transform is
 * ignored by the glTF spec — so a fix left on the node is a fix that does
 * nothing the moment `applyRig` attaches a skin. See `bakeNodeTransforms`.
 */
export async function applyOrientationFixes(
  inPath: string,
  outPath: string,
  fixes: OrientationFix[],
): Promise<{ applied: OrientationFix[]; facingAfter: FacingReport }> {
  const io = new NodeIO();
  const doc = await io.readBinary(await Deno.readFile(inPath));

  for (const fix of fixes) {
    const positions = worldPositions(doc);
    const b = boundsOf(positions);
    let m: number[] | null = null;
    switch (fix) {
      case 'rotate-90':
        m = yawMatrix(90);
        break;
      case 'rotate-180':
        m = yawMatrix(180);
        break;
      case 'rotate-270':
        m = yawMatrix(270);
        break;
      case 'face-front': {
        const report = detectFacing(positions);
        const needed = report.suggestedFix;
        m = needed === undefined ? null : yawMatrix(
          needed === 'rotate-90' ? 90 : needed === 'rotate-270' ? 270 : 180,
        );
        break;
      }
      case 'feet-ground': {
        const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -b.min[1], 0, 1];
        m = t;
        break;
      }
      case 'center': {
        // centre horizontally only — vertical placement is feet-ground's job,
        // and doing both here would make the two verbs fight
        const cx = (b.min[0] + b.max[0]) / 2;
        const cz = (b.min[2] + b.max[2]) / 2;
        m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -cx, 0, -cz, 1];
        break;
      }
    }
    if (m === null) continue; // already correct: a no-op fix is not an error
    for (const scene of doc.getRoot().listScenes()) {
      for (const node of scene.listChildren()) {
        node.setMatrix(mul(m, [...node.getMatrix()]) as never);
      }
    }
  }

  bakeNodeTransforms(doc);
  await Deno.writeFile(outPath, await io.writeBinary(doc));
  const after = await detectFacingFile(outPath);
  return { applied: fixes, facingAfter: after };
}
