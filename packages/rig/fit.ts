/**
 * Track A's roster fit (P3-T4): ONE canonical rigged humanoid, fitted to each
 * generated mesh, so the skeleton, the UV layout and the animation bindings are
 * IDENTICAL across a hundred characters (schema/roster.ts on why Track A
 * exists). No GPU, no sidecar — this is arithmetic over two glbs.
 *
 * ## Which mesh is the character
 *
 * The character we ship is the CANONICAL BODY. Its topology, its UVs and its
 * authored weights survive the fit untouched; the target mesh contributes
 * SHAPE and nothing else. That inversion is the whole of Track A — weights
 * authored against this skeleton ARE the shareable asset, and re-deriving them
 * per character (Track B) is exactly what makes a roster unshareable. So the
 * transfer runs body -> target, not target -> body: every body vertex is
 * projected onto the target surface and moved there, taking the generated
 * character's silhouette while the mesh stays ours. Identity then comes from
 * the surface (textures, decals, attachments, bone masks), as the contract says.
 *
 * ## The order, which is also the explanation
 *
 * 1. MEASURE both, in world space after node transforms. The target's standing
 *    height is what the body must match (D-012: +Y up, metres, feet at Y=0).
 * 2. SHAPE FIT: a per-axis affine map taking the body's bounds onto the
 *    target's proportions, applied to the body's VERTICES and its JOINT REST
 *    POSITIONS together. Joints that do not move with the skin make every
 *    downstream pose wrong, so they move in the same statement.
 * 3. PROJECT each fitted vertex onto the nearest point of the target surface,
 *    blended by the falloff below.
 * 4. VALIDATE numerically — surface error, renormalized rows, stray joints —
 *    because this is the difference between a fit and a mess.
 * 5. WRITE the rigged glb with applyRig's conventions: one skin, inverse bind
 *    matrices rebuilt for the MOVED joints, JOINTS_0/WEIGHTS_0 preserved.
 *
 * ## The band choice (step 2)
 *
 * Height drives Y outright. X and Z come from SILHOUETTE BANDS: horizontal
 * slabs at matching FRACTIONS of standing height, so a 2.2 m target's shoulders
 * are compared with the body's shoulders and not with its ribs. Three bands are
 * measured — shoulders (0.70-0.85), waist (0.45-0.60), hips (0.30-0.45) — and
 * the per-band extent ratios are combined with a MEDIAN.
 *
 * - Those three, because they are where a humanoid's build actually reads. The
 *   head band is excluded on purpose: head size does not track build (a chibi
 *   has a huge head on a small body) and it would drag a broad character's
 *   shoulders narrow. The ankle band is excluded because its extent is near
 *   zero, so its ratio is all noise.
 * - MEDIAN, not mean: one band can be corrupted by a prop, a cape or a
 *   hairstyle crossing it, and the median ignores that outlier instead of
 *   averaging it in.
 * - Bands are height-NORMALIZED on both meshes, so the comparison is by
 *   proportion and is independent of the Y scale being solved for.
 * - A band with too little geometry on either side is skipped; if no band
 *   survives (the target is not remotely a standing figure) the fit falls back
 *   to the whole-body bounding-box ratio, which is the honest last resort.
 *
 * The result is ONE scale triple (the frozen `FitResult.scale`), so a broad
 * character gets broad shoulders instead of being uniformly inflated.
 *
 * ## The falloff (step 3)
 *
 * With `d` the distance from a fitted vertex to the nearest point on the target
 * surface, and `H` the fitted standing height:
 *
 *   d <= 0.02·H            -> weight 1: snap onto the target outright
 *   0.02·H < d < 0.15·H    -> weight ramps linearly 1 -> 0
 *   d >= 0.15·H            -> weight 0: KEEP the fitted position, and count it
 *
 * Inside 2% of standing height the nearest surface is unambiguously the same
 * body part, so the target's silhouette wins. Past 15% it is more likely a
 * DIFFERENT part — the nearest surface to a hand held at the hip is the hip —
 * and dragging the vertex there is precisely what tears a body, so we refuse.
 * The linear ramp between keeps the boundary from reading as a crease.
 * Unprojected vertices are REPORTED (`unprojectedVertices`) rather than
 * stretched: "we could not reach the target here" is a fact the caller needs.
 */
import { type Document, NodeIO } from '@gltf-transform/core';
import type { BodyRegion, CanonicalBody, FitResult } from '@spritebook/schema';
import {
  CANONICAL_BODY_FILE,
  CANONICAL_BODY_MANIFEST,
  CanonicalBodySchema,
  canonicalJson,
  FitResultSchema,
  parseWith,
  SCHEMA_VERSION,
} from '@spritebook/schema';
import { UAL_HUMANOID } from '../anim/profile.ts';
import {
  qConj,
  qFromMat4,
  qMul,
  qNormalize,
  qRotate,
  type Quat,
  type Vec3,
  vSub,
} from '../anim/quat.ts';
import { IBM_IDENTITY_TOLERANCE, packWeightRows } from './apply.ts';
import { boundsOf } from './orient.ts';
import {
  documentToRiggedAsset,
  mat4InvertRigid,
  mat4Multiply,
  restWorlds,
  type RiggedAsset,
  skinAll,
  skinMatrices,
} from './skin.ts';

/** Silhouette bands as fractions of standing height (0 = feet, 1 = crown). */
export const FIT_BANDS: readonly (readonly [number, number])[] = [
  [0.7, 0.85], // shoulders and upper arms
  [0.45, 0.6], // waist
  [0.3, 0.45], // hips and upper thigh
];
/** A band with fewer vertices than this on either mesh is too thin to trust. */
export const BAND_MIN_VERTICES = 8;
/** Within this fraction of standing height, snap fully onto the target. */
export const SNAP_FRACTION = 0.02;
/** Beyond this fraction of standing height, keep the fitted position. */
export const CUTOFF_FRACTION = 0.15;
/** A joint this far outside the target's bounds (fraction of height) is stray. */
export const STRAY_TOLERANCE_FRACTION = 0.01;
/** The source body's rest pose must round-trip its own IBMs to this, in metres. */
export const REST_ROUNDTRIP_TOLERANCE_M = 1e-4;

export interface FitCanonicalBodyOptions {
  /** the canonical rigged body (body.glb) */
  bodyPath: string;
  /** its manifest (body.json, a CanonicalBody) */
  bodyManifestPath: string;
  /** the generated mesh whose shape the body must take */
  targetPath: string;
  /** where the fitted rigged glb is written */
  outPath: string;
  /**
   * Declare the target's real standing height, metres. A generated mesh has no
   * absolute scale, so this uniformly rescales the TARGET about its feet before
   * anything is measured — bands, projection and the reported error then all
   * speak the same metres. Absent: the target's own measured height is used.
   */
  heightM?: number;
}

/**
 * The frozen FitResult plus one additive count, exactly as `ApplyRigResult`
 * adds `truncatedVertices`: a vertex the target could not reach is a silent
 * hole in the fit, and the frozen shape has nowhere to say so. The frozen
 * fields are validated against `FitResultSchema` before this is returned.
 */
export interface FitReport extends FitResult {
  /** vertices whose nearest target surface was past the falloff cutoff */
  unprojectedVertices: number;
}

// ---------------------------------------------------------------------------
// Geometry: nearest point on a triangle, and a grid to find it in
// ---------------------------------------------------------------------------

export interface Surface {
  /** world-space xyz, primitives concatenated */
  positions: Float32Array;
  /** triangle list into `positions` */
  indices: Uint32Array;
}

/**
 * Every triangle of every mesh in world space. Non-indexed primitives get a
 * synthesized index run, exactly as `documentToRiggedAsset` does, so the two
 * readers agree on what "the surface" means.
 */
export function readSurface(doc: Document, label: string): Surface {
  const pos: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const acc = prim.getAttribute('POSITION');
      if (!acc) continue;
      const arr = acc.getArray()!;
      const count = arr.length / 3;
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2];
        pos.push(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        );
      }
      const ind = prim.getIndices();
      if (ind) {
        const src = ind.getArray()!;
        for (let i = 0; i + 2 < src.length; i += 3) {
          idx.push(src[i] + base, src[i + 1] + base, src[i + 2] + base);
        }
      } else {
        for (let i = 0; i + 2 < count; i += 3) idx.push(base + i, base + i + 1, base + i + 2);
      }
      base += count;
    }
  }
  if (idx.length === 0) {
    throw new Error(
      `${label}: no triangles — the target contributes SHAPE to the fit, and a mesh ` +
        'with no surface has none to contribute',
    );
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

function sqDist(p: Vec3, x: number, y: number, z: number): number {
  const dx = p[0] - x, dy = p[1] - y, dz = p[2] - z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Closest point on triangle abc to p (Ericson's barycentric region test),
 * written on scalars because it runs once per vertex per candidate triangle.
 * Returns the SQUARED distance and fills `out`. A degenerate (zero-area)
 * triangle falls back to its closest corner rather than dividing by zero.
 */
export function closestOnTriangle(
  p: Vec3,
  t: Float32Array,
  a: number,
  b: number,
  c: number,
  out: Vec3,
): number {
  const ax = t[a], ay = t[a + 1], az = t[a + 2];
  const bx = t[b], by = t[b + 1], bz = t[b + 2];
  const cx = t[c], cy = t[c + 1], cz = t[c + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const set = (x: number, y: number, z: number): number => {
    out[0] = x, out[1] = y, out[2] = z;
    return sqDist(p, x, y, z);
  };
  if (d1 <= 0 && d2 <= 0) return set(ax, ay, az);

  const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(bx, by, bz);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0 && d1 !== d3) {
    const v = d1 / (d1 - d3);
    return set(ax + abx * v, ay + aby * v, az + abz * v);
  }

  const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(cx, cy, cz);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0 && d2 !== d6) {
    const w = d2 / (d2 - d6);
    return set(ax + acx * w, ay + acy * w, az + acz * w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0 && d4 - d3 + (d5 - d6) !== 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }

  const denom = va + vb + vc;
  if (!(denom > 0)) {
    // zero-area sliver: the region tests above cannot bracket it, so take the
    // nearest corner rather than dividing by a vanishing barycentric sum
    const da = sqDist(p, ax, ay, az);
    const db = sqDist(p, bx, by, bz);
    const dc = sqDist(p, cx, cy, cz);
    if (da <= db && da <= dc) return set(ax, ay, az);
    return db <= dc ? set(bx, by, bz) : set(cx, cy, cz);
  }
  const v = vb / denom;
  const w = vc / denom;
  return set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/**
 * Uniform grid over the target's triangles, so the fit is O(V) rather than
 * O(V·T) — a 5 k-vertex body against a 20 k-triangle target is 100 M triangle
 * tests brute force, which is minutes for a path whose whole selling point is
 * that it needs no GPU.
 *
 * Cells are CUBIC and every triangle is registered in every cell its AABB
 * touches, which makes the expanding-ring query EXACT: cells at ring `r` from
 * the query's own cell hold no point closer than `(r-1)·cell`, so once the best
 * hit is inside that radius no unscanned cell can beat it. Exact matters —
 * `meanSurfaceErrorM` is the headline number, and an approximate nearest would
 * quietly under-report it.
 */
export class TriangleGrid {
  private readonly min: Vec3;
  private readonly dims: [number, number, number];
  private readonly cell: number;
  private readonly start: Uint32Array;
  private readonly items: Uint32Array;

  constructor(private readonly surface: Surface) {
    const b = boundsOf(surface.positions);
    const ext: Vec3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const diag = Math.hypot(ext[0], ext[1], ext[2]);
    const triCount = surface.indices.length / 3;
    const n = Math.min(64, Math.max(4, Math.ceil(Math.cbrt(triCount) * 2)));
    this.cell = Math.max(diag / n, 1e-9);
    this.min = [b.min[0], b.min[1], b.min[2]];
    this.dims = [
      Math.max(1, Math.ceil(ext[0] / this.cell)),
      Math.max(1, Math.ceil(ext[1] / this.cell)),
      Math.max(1, Math.ceil(ext[2] / this.cell)),
    ];

    // CSR buckets: count overlaps, prefix-sum, fill. Arrays-of-arrays would
    // allocate one object per cell for a structure read once per vertex.
    const cells = this.dims[0] * this.dims[1] * this.dims[2];
    const counts = new Uint32Array(cells + 1);
    const range = (tri: number): [number, number, number, number, number, number] => {
      const lo: Vec3 = [Infinity, Infinity, Infinity];
      const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 3; k++) {
        const v = surface.indices[tri * 3 + k] * 3;
        for (let a = 0; a < 3; a++) {
          const c = surface.positions[v + a];
          if (c < lo[a]) lo[a] = c;
          if (c > hi[a]) hi[a] = c;
        }
      }
      return [
        this.axis(lo[0], 0),
        this.axis(hi[0], 0),
        this.axis(lo[1], 1),
        this.axis(hi[1], 1),
        this.axis(lo[2], 2),
        this.axis(hi[2], 2),
      ];
    };
    for (let tri = 0; tri < triCount; tri++) {
      const [x0, x1, y0, y1, z0, z1] = range(tri);
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) counts[this.cellIndex(x, y, z) + 1]++;
        }
      }
    }
    for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
    this.start = counts;
    this.items = new Uint32Array(counts[cells]);
    const cursor = counts.slice(0, cells);
    for (let tri = 0; tri < triCount; tri++) {
      const [x0, x1, y0, y1, z0, z1] = range(tri);
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) this.items[cursor[this.cellIndex(x, y, z)]++] = tri;
        }
      }
    }
  }

  private axis(v: number, a: number): number {
    const i = Math.floor((v - this.min[a]) / this.cell);
    return i < 0 ? 0 : i >= this.dims[a] ? this.dims[a] - 1 : i;
  }

  private cellIndex(x: number, y: number, z: number): number {
    return (z * this.dims[1] + y) * this.dims[0] + x;
  }

  /** Nearest point on the surface to `p`; returns the distance, fills `out`. */
  nearest(p: Vec3, out: Vec3): number {
    const ci = this.axis(p[0], 0), cj = this.axis(p[1], 1), ck = this.axis(p[2], 2);
    const maxRing = Math.max(
      ci,
      this.dims[0] - 1 - ci,
      cj,
      this.dims[1] - 1 - cj,
      ck,
      this.dims[2] - 1 - ck,
    );
    let best = Infinity; // squared, until the return
    const hit: Vec3 = [0, 0, 0];
    for (let r = 0; r <= maxRing; r++) {
      // nothing in an unscanned cell can be closer than (r-1) cells away
      const bound = (r - 1) * this.cell;
      if (r > 0 && bound > 0 && best <= bound * bound) break;
      const x0 = Math.max(0, ci - r), x1 = Math.min(this.dims[0] - 1, ci + r);
      const y0 = Math.max(0, cj - r), y1 = Math.min(this.dims[1] - 1, cj + r);
      const z0 = Math.max(0, ck - r), z1 = Math.min(this.dims[2] - 1, ck + r);
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            // shell only: interior cells were scanned at a smaller ring
            if (Math.max(Math.abs(x - ci), Math.abs(y - cj), Math.abs(z - ck)) !== r) continue;
            const cell = this.cellIndex(x, y, z);
            for (let s = this.start[cell]; s < this.start[cell + 1]; s++) {
              const tri = this.items[s] * 3;
              const d2 = closestOnTriangle(
                p,
                this.surface.positions,
                this.surface.indices[tri] * 3,
                this.surface.indices[tri + 1] * 3,
                this.surface.indices[tri + 2] * 3,
                hit,
              );
              if (d2 < best) {
                best = d2;
                out[0] = hit[0], out[1] = hit[1], out[2] = hit[2];
              }
            }
          }
        }
      }
    }
    return Math.sqrt(best);
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

type Bounds = ReturnType<typeof boundsOf>;

/** Extent along `axis` of the vertices inside one height band, and how many. */
function bandExtent(
  p: Float32Array,
  minY: number,
  height: number,
  band: readonly [number, number],
  axis: 0 | 2,
): { extent: number; count: number } {
  const lo = minY + band[0] * height;
  const hi = minY + band[1] * height;
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1];
    if (y < lo || y > hi) continue;
    const v = p[i + axis];
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  return { extent: count > 0 ? max - min : 0, count };
}

/**
 * The horizontal scale for one axis: the MEDIAN of the per-band extent ratios
 * (see the module header on why these bands and why the median). Bands too
 * sparse to mean anything are skipped; with none left the whole-body bounding
 * box is the last resort, which is the uniform answer and is admitted as such.
 */
export function bandScale(
  body: Float32Array,
  bodyBounds: Bounds,
  target: Float32Array,
  targetBounds: Bounds,
  axis: 0 | 2,
  label: string,
): number {
  const bodyH = bodyBounds.max[1] - bodyBounds.min[1];
  const targetH = targetBounds.max[1] - targetBounds.min[1];
  const ratios: number[] = [];
  for (const band of FIT_BANDS) {
    const b = bandExtent(body, bodyBounds.min[1], bodyH, band, axis);
    const t = bandExtent(target, targetBounds.min[1], targetH, band, axis);
    if (b.count < BAND_MIN_VERTICES || t.count < BAND_MIN_VERTICES) continue;
    if (!(b.extent > 0) || !(t.extent > 0)) continue;
    ratios.push(t.extent / b.extent);
  }
  if (ratios.length === 0) {
    const b = bodyBounds.max[axis] - bodyBounds.min[axis];
    const t = targetBounds.max[axis] - targetBounds.min[axis];
    if (!(b > 0) || !(t > 0)) {
      throw new Error(
        `${label}: no silhouette band and no bounding box gives a ${
          axis === 0 ? 'X' : 'Z'
        } extent for both meshes (body ${b}, target ${t}) — the target is flat on ` +
          'that axis, so there is no proportion to fit to',
      );
    }
    return t / b;
  }
  ratios.sort((a, b) => a - b);
  const mid = ratios.length >> 1;
  return ratios.length % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}

/**
 * The body's rest pose must reproduce its authored positions through its own
 * inverse bind matrices, or nothing downstream means anything: the fit rebuilds
 * those matrices from moved joints, and it can only do that if the ones it
 * started from were consistent.
 */
export function assertRestRoundTrip(asset: RiggedAsset, label: string): void {
  const mats = skinMatrices(restWorlds(asset), asset.inverseBind, asset.jointCount);
  const skinned = skinAll(asset, mats);
  for (let v = 0; v < asset.vertexCount; v++) {
    const dx = skinned[v * 3] - asset.positions[v * 3];
    const dy = skinned[v * 3 + 1] - asset.positions[v * 3 + 1];
    const dz = skinned[v * 3 + 2] - asset.positions[v * 3 + 2];
    const d = Math.hypot(dx, dy, dz);
    if (!(d <= REST_ROUNDTRIP_TOLERANCE_M)) {
      throw new Error(
        `${label}: vertex ${v} is ${d} m from where its own skin puts it at rest — the ` +
          'inverse bind matrices do not invert the rest pose. The usual cause is a ' +
          'skeleton hanging under a transformed node (Blender exports an `Armature`); ' +
          'bake that transform into the joints before building the canonical body',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Writing the fitted body
// ---------------------------------------------------------------------------

interface PrimSlot {
  prim: ReturnType<ReturnType<Document['createMesh']>['listPrimitives']>[number];
  first: number;
  count: number;
}

/**
 * Primitives in `listMeshes()`/`listPrimitives()` order — the SAME order
 * `documentToRiggedAsset` concatenates vertices in, which is what makes a flat
 * vertex index addressable back into the document.
 */
function primSlots(doc: Document, label: string): PrimSlot[] {
  const slots: PrimSlot[] = [];
  const seen = new Set<unknown>();
  let first = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) throw new Error(`${label}: mesh "${mesh.getName()}" primitive has no POSITION`);
      if (seen.has(pos)) {
        throw new Error(
          `${label}: two primitives share a POSITION accessor — the fit writes per-vertex ` +
            'positions and cannot address a shared buffer; split the primitives first',
        );
      }
      seen.add(pos);
      slots.push({ prim, first, count: pos.getArray()!.length / 3 });
      first += pos.getArray()!.length / 3;
    }
  }
  return slots;
}

/**
 * Area-weighted vertex normals for one primitive. A non-uniform scale followed
 * by a per-vertex projection invalidates authored normals, and the normal AOV
 * is a BAKE OUTPUT (D-010) — shipping stale normals would be wrong pixels with
 * nothing failing. Split vertices keep hard edges by construction: they are
 * separate indices, so nothing averages across them.
 */
function vertexNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array<ArrayBuffer> {
  const n = new Float32Array(positions.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    // un-normalized cross product: its length is twice the area, which is the
    // weight we want
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      n[v] += nx;
      n[v + 1] += ny;
      n[v + 2] += nz;
    }
  }
  for (let v = 0; v < n.length; v += 3) {
    const len = Math.hypot(n[v], n[v + 1], n[v + 2]);
    if (len > 1e-12) {
      n[v] /= len, n[v + 1] /= len, n[v + 2] /= len;
    } else {
      n[v] = 0, n[v + 1] = 1, n[v + 2] = 0; // degenerate fan: up, not NaN
    }
  }
  return n;
}

/**
 * Rebuild the document in place: fitted positions, joint frames at their moved
 * rest positions, and inverse bind matrices that are the EXACT rigid inverse of
 * those frames (apply.ts's rule — an exact transpose is the difference between
 * a rest round-trip at 1e-7 and one drifting at 1e-4 down a deep chain).
 *
 * Joint frames keep their rest ROTATION and take only the mapped POSITION. A
 * non-uniform scale folded into a joint frame would stay rigid at rest and then
 * shear the limb through every animated pose; a bone whose length changed while
 * its axis held is the cheaper lie, and it is the one the skin was scaled by.
 */
function writeFitted(
  doc: Document,
  asset: RiggedAsset,
  positions: Float32Array,
  jointPos: Float32Array,
  jointRot: Quat[],
  rows: { joints: Uint32Array; weights: Float32Array },
  label: string,
): void {
  for (const slot of primSlots(doc, label)) {
    const sub = Float32Array.from(
      positions.subarray(slot.first * 3, (slot.first + slot.count) * 3),
    );
    slot.prim.getAttribute('POSITION')!.setArray(sub);
    const normal = slot.prim.getAttribute('NORMAL');
    if (normal) {
      const ind = slot.prim.getIndices();
      const local = ind
        ? Uint32Array.from(ind.getArray()!)
        : Uint32Array.from({ length: slot.count }, (_, i) => i);
      normal.setArray(vertexNormals(sub, local));
    }
    const narrow = asset.jointCount <= 256;
    const from = slot.first * 4;
    const to = from + slot.count * 4;
    const src = rows.joints.subarray(from, to);
    slot.prim.getAttribute('JOINTS_0')!.setArray(
      narrow ? Uint8Array.from(src) : Uint16Array.from(src),
    );
    slot.prim.getAttribute('WEIGHTS_0')!.setArray(
      Float32Array.from(rows.weights.subarray(from, to)),
    );
  }

  const skin = doc.getRoot().listSkins()[0];
  const nodes = skin.listJoints();
  const worlds = new Float32Array(asset.jointCount * 16);
  const ibm = new Float32Array(asset.jointCount * 16);
  for (let i = 0; i < asset.jointCount; i++) {
    const rot = jointRot[i];
    const pos: Vec3 = [jointPos[i * 3], jointPos[i * 3 + 1], jointPos[i * 3 + 2]];
    const m = worlds.subarray(i * 16, i * 16 + 16);
    const [x, y, z, w] = rot;
    m[0] = 1 - 2 * (y * y + z * z), m[1] = 2 * (x * y + w * z), m[2] = 2 * (x * z - w * y);
    m[4] = 2 * (x * y - w * z), m[5] = 1 - 2 * (x * x + z * z), m[6] = 2 * (y * z + w * x);
    m[8] = 2 * (x * z + w * y), m[9] = 2 * (y * z - w * x), m[10] = 1 - 2 * (x * x + y * y);
    m[12] = pos[0], m[13] = pos[1], m[14] = pos[2], m[15] = 1;
    ibm.set(mat4InvertRigid(m), i * 16);

    const p = asset.jointParents[i];
    if (p < 0) {
      nodes[i].setTranslation(pos).setRotation(rot).setScale([1, 1, 1]);
    } else {
      const pInv = qConj(jointRot[p]);
      const parent: Vec3 = [jointPos[p * 3], jointPos[p * 3 + 1], jointPos[p * 3 + 2]];
      nodes[i].setTranslation(qRotate(pInv, vSub(pos, parent)))
        .setRotation(qNormalize(qMul(pInv, rot)))
        .setScale([1, 1, 1]);
    }
  }

  // the numeric proof that the rebuilt bind matrices invert the moved frames
  const check = new Float32Array(16);
  for (let i = 0; i < asset.jointCount; i++) {
    mat4Multiply(worlds.subarray(i * 16, i * 16 + 16), ibm.subarray(i * 16, i * 16 + 16), check);
    for (let e = 0; e < 16; e++) {
      const want = e % 5 === 0 ? 1 : 0;
      if (!Number.isFinite(check[e]) || Math.abs(check[e] - want) > IBM_IDENTITY_TOLERANCE) {
        throw new Error(
          `${label}: joint "${asset.jointNames[i]}" inverse bind matrix does not invert its ` +
            `fitted rest transform (element ${e} of world.IBM is ${check[e]}, expected ${want})`,
        );
      }
    }
  }
  skin.getInverseBindMatrices()!.setArray(ibm);
}

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

/**
 * Fit the canonical body to `targetPath` and write the fitted rigged glb.
 * Returns the numbers that say whether it worked — `meanSurfaceErrorM` is the
 * honest headline (the body will never match a generated silhouette exactly,
 * and a fit claiming otherwise is lying) and `strayJoints` is the real failure.
 *
 * Stray joints are REPORTED, not thrown: the caller decides whether a torn fit
 * is fatal, and being able to open the file is how anyone diagnoses it. Only
 * non-finite arithmetic throws, because there is nothing left to look at.
 */
export async function fitCanonicalBody(opts: FitCanonicalBodyOptions): Promise<FitReport> {
  const label = 'fitCanonicalBody';
  const io = new NodeIO();

  // ---- the canonical body ------------------------------------------------
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(await Deno.readTextFile(opts.bodyManifestPath));
  } catch (err) {
    throw new Error(
      `${label}: cannot read body manifest "${opts.bodyManifestPath}" ` +
        `(${(err as Error).message})`,
    );
  }
  const manifest = parseWith(
    CanonicalBodySchema,
    manifestJson,
    `canonical body manifest "${opts.bodyManifestPath}"`,
  );

  let bodyDoc: Document;
  try {
    bodyDoc = await io.readBinary(await Deno.readFile(opts.bodyPath));
  } catch (err) {
    throw new Error(`${label}: cannot read body "${opts.bodyPath}" (${(err as Error).message})`);
  }
  const asset = documentToRiggedAsset(bodyDoc, `${label}: "${opts.bodyPath}"`);
  if (asset.vertexCount !== manifest.vertexCount || asset.jointCount !== manifest.jointCount) {
    throw new Error(
      `${label}: "${opts.bodyPath}" has ${asset.vertexCount} vertices and ` +
        `${asset.jointCount} joints but "${opts.bodyManifestPath}" declares ` +
        `${manifest.vertexCount} and ${manifest.jointCount} — the glb and its manifest are ` +
        'from different builds; rebuild the canonical body',
    );
  }
  assertRestRoundTrip(asset, `${label}: "${opts.bodyPath}"`);

  // ---- 1. measure both ---------------------------------------------------
  let targetDoc: Document;
  try {
    targetDoc = await io.readBinary(await Deno.readFile(opts.targetPath));
  } catch (err) {
    throw new Error(
      `${label}: cannot read target "${opts.targetPath}" (${(err as Error).message})`,
    );
  }
  const surface = readSurface(targetDoc, `${label}: "${opts.targetPath}"`);
  let targetBounds = boundsOf(surface.positions);
  const measuredHeight = targetBounds.max[1] - targetBounds.min[1];
  if (!(measuredHeight > 0)) {
    throw new Error(
      `${label}: "${opts.targetPath}" has zero standing height (Y extent ${measuredHeight}) — ` +
        'the fit scales the body onto the target height, and there is none (D-012: +Y up)',
    );
  }
  if (opts.heightM !== undefined) {
    if (!Number.isFinite(opts.heightM) || opts.heightM <= 0) {
      throw new Error(`${label}: heightM must be a positive number, got ${opts.heightM}`);
    }
    // uniform, about the feet and the horizontal centre, so D-012's ground
    // plane survives the rescale
    const s = opts.heightM / measuredHeight;
    const cx = (targetBounds.min[0] + targetBounds.max[0]) / 2;
    const cz = (targetBounds.min[2] + targetBounds.max[2]) / 2;
    const y0 = targetBounds.min[1];
    for (let i = 0; i < surface.positions.length; i += 3) {
      surface.positions[i] = cx + (surface.positions[i] - cx) * s;
      surface.positions[i + 1] = y0 + (surface.positions[i + 1] - y0) * s;
      surface.positions[i + 2] = cz + (surface.positions[i + 2] - cz) * s;
    }
    targetBounds = boundsOf(surface.positions);
  }
  const fitHeight = targetBounds.max[1] - targetBounds.min[1];

  const bodyBounds = boundsOf(asset.positions);
  const bodyHeight = bodyBounds.max[1] - bodyBounds.min[1];
  if (!(bodyHeight > 0)) {
    throw new Error(
      `${label}: "${opts.bodyPath}" has zero standing height — the canonical body must stand ` +
        'along +Y with its feet at Y=0 (D-012)',
    );
  }

  // ---- 2. shape fit ------------------------------------------------------
  const scale: [number, number, number] = [
    bandScale(asset.positions, bodyBounds, surface.positions, targetBounds, 0, label),
    fitHeight / bodyHeight,
    bandScale(asset.positions, bodyBounds, surface.positions, targetBounds, 2, label),
  ];
  (['X', 'Y', 'Z'] as const).forEach((axis, i) => {
    if (!Number.isFinite(scale[i]) || scale[i] <= 0) {
      throw new Error(
        `${label}: the ${axis} fit scale came out ${scale[i]} — the target's ${axis} ` +
          'proportions are degenerate, so there is nothing to fit the body to',
      );
    }
  });

  // Y anchors on the target's feet (D-012); X and Z anchor on its horizontal
  // centre, because a body stuck to a bounding-box corner is off-centre in
  // every direction the bake renders
  const anchor = (v: number, axis: 0 | 1 | 2): number => {
    const from = axis === 1 ? bodyBounds.min[1] : (bodyBounds.min[axis] + bodyBounds.max[axis]) / 2;
    const to = axis === 1
      ? targetBounds.min[1]
      : (targetBounds.min[axis] + targetBounds.max[axis]) / 2;
    return to + (v - from) * scale[axis];
  };

  const fitted = new Float32Array(asset.positions.length);
  for (let i = 0; i < asset.positions.length; i += 3) {
    fitted[i] = anchor(asset.positions[i], 0);
    fitted[i + 1] = anchor(asset.positions[i + 1], 1);
    fitted[i + 2] = anchor(asset.positions[i + 2], 2);
  }

  // the joints move in the SAME statement as the skin: a rest position left
  // behind makes every downstream pose wrong
  const worlds = restWorlds(asset);
  const jointPos = new Float32Array(asset.jointCount * 3);
  const jointRot: Quat[] = [];
  for (let j = 0; j < asset.jointCount; j++) {
    const m = worlds.subarray(j * 16, j * 16 + 16);
    try {
      jointRot.push(qFromMat4(m));
    } catch (err) {
      throw new Error(
        `${label}: joint "${asset.jointNames[j]}" has an unusable rest frame ` +
          `(${(err as Error).message})`,
      );
    }
    jointPos[j * 3] = anchor(m[12], 0);
    jointPos[j * 3 + 1] = anchor(m[13], 1);
    jointPos[j * 3 + 2] = anchor(m[14], 2);
  }

  // ---- 3. project onto the target surface --------------------------------
  const grid = new TriangleGrid(surface);
  const snap = SNAP_FRACTION * fitHeight;
  const cutoff = CUTOFF_FRACTION * fitHeight;
  const p: Vec3 = [0, 0, 0];
  const q: Vec3 = [0, 0, 0];
  let unprojectedVertices = 0;
  for (let v = 0; v < asset.vertexCount; v++) {
    p[0] = fitted[v * 3], p[1] = fitted[v * 3 + 1], p[2] = fitted[v * 3 + 2];
    const d = grid.nearest(p, q);
    let w: number;
    if (d <= snap) w = 1;
    else if (d >= cutoff) {
      w = 0;
      unprojectedVertices++;
    } else w = 1 - (d - snap) / (cutoff - snap);
    if (w === 0) continue; // keep the fitted position; never stretch to reach
    fitted[v * 3] = p[0] + (q[0] - p[0]) * w;
    fitted[v * 3 + 1] = p[1] + (q[1] - p[1]) * w;
    fitted[v * 3 + 2] = p[2] + (q[2] - p[2]) * w;
  }

  // ---- 4. validate, before anything is written ---------------------------
  for (let v = 0; v < asset.vertexCount; v++) {
    for (let a = 0; a < 3; a++) {
      if (!Number.isFinite(fitted[v * 3 + a])) {
        throw new Error(
          `${label}: fitted vertex ${v} component ${'xyz'[a]} is ${fitted[v * 3 + a]} — the ` +
            `fit produced non-finite geometry (scale [${scale.join(', ')}])`,
        );
      }
    }
  }
  for (let j = 0; j < asset.jointCount; j++) {
    for (let a = 0; a < 3; a++) {
      if (!Number.isFinite(jointPos[j * 3 + a])) {
        throw new Error(
          `${label}: fitted joint "${asset.jointNames[j]}" component ${'xyz'[a]} is ` +
            `${jointPos[j * 3 + a]} — the fit produced a non-finite rest position`,
        );
      }
    }
  }

  // measured on the FINAL positions: what shipped, not what was intended
  let errorSum = 0;
  let maxSurfaceErrorM = 0;
  for (let v = 0; v < asset.vertexCount; v++) {
    p[0] = fitted[v * 3], p[1] = fitted[v * 3 + 1], p[2] = fitted[v * 3 + 2];
    const d = grid.nearest(p, q);
    errorSum += d;
    if (d > maxSurfaceErrorM) maxSurfaceErrorM = d;
  }
  const meanSurfaceErrorM = errorSum / asset.vertexCount;

  const strayTolerance = STRAY_TOLERANCE_FRACTION * fitHeight;
  const strayJoints: string[] = [];
  for (let j = 0; j < asset.jointCount; j++) {
    for (let a = 0; a < 3; a++) {
      const v = jointPos[j * 3 + a];
      if (v < targetBounds.min[a] - strayTolerance || v > targetBounds.max[a] + strayTolerance) {
        strayJoints.push(asset.jointNames[j]);
        break;
      }
    }
  }

  // the body's own weights, repaired and COUNTED by the one packer this
  // package has — Track A keeps them, it does not re-derive them
  const rows = packWeightRows(
    asset.joints,
    asset.weights,
    asset.vertexCount,
    4,
    asset.jointCount,
    `${label}: "${opts.bodyPath}"`,
  );

  // ---- 5. write ----------------------------------------------------------
  writeFitted(bodyDoc, asset, fitted, jointPos, jointRot, rows, label);
  await Deno.writeFile(opts.outPath, await io.writeBinary(bodyDoc));

  const frozen = parseWith(FitResultSchema, {
    schemaVersion: SCHEMA_VERSION,
    bodyId: manifest.id,
    scale,
    heightM: fitHeight,
    meanSurfaceErrorM,
    maxSurfaceErrorM,
    renormalizedVertices: rows.renormalizedVertices,
    strayJoints,
  }, `${label} result`);
  return { ...frozen, unprojectedVertices };
}

// ---------------------------------------------------------------------------
// Building the canonical body
// ---------------------------------------------------------------------------

/**
 * Joints -> region, over UAL_HUMANOID's core set. Every core joint belongs to
 * exactly one region, so a bone mask can address all of them: `root` rides with
 * the torso because it is the motion root and owns no surface of its own, and
 * hands and feet are their own regions because they are what attachments
 * (props, prosthetics) and boots actually replace.
 */
export const BODY_REGIONS: readonly { id: string; joints: readonly string[] }[] = [
  { id: 'head', joints: ['neck_01', 'Head'] },
  { id: 'torso', joints: ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03'] },
  { id: 'arm-l', joints: ['clavicle_l', 'upperarm_l', 'lowerarm_l'] },
  { id: 'hand-l', joints: ['hand_l'] },
  { id: 'arm-r', joints: ['clavicle_r', 'upperarm_r', 'lowerarm_r'] },
  { id: 'hand-r', joints: ['hand_r'] },
  { id: 'leg-l', joints: ['thigh_l', 'calf_l'] },
  { id: 'foot-l', joints: ['foot_l'] },
  { id: 'leg-r', joints: ['thigh_r', 'calf_r'] },
  { id: 'foot-r', joints: ['foot_r'] },
];

export interface BuildCanonicalBodyOptions {
  /** a rigged humanoid glb carrying the UAL skeleton, UVs and a skin */
  sourcePath: string;
  /** body.glb and body.json land here */
  outDir: string;
  /** slug; binds every fit result to the body it came from */
  id: string;
  displayName: string;
  /** SPDX-ish id of the SOURCE mesh — it ships with us, so it must be permissive */
  license: string;
  source: string;
  /** override the measured standing height, metres */
  heightM?: number;
}

export interface BuildCanonicalBodyResult {
  body: CanonicalBody;
  glbPath: string;
  manifestPath: string;
}

/**
 * Side from the joint NAMING CONVENTION (`_l` / `_r`), never from geometry:
 * anim/profile.ts already learned that assigning sides from coordinates ties
 * the answer to float noise, and D-008's mirroring rules are only as
 * trustworthy as this label.
 */
function sideOf(joints: readonly string[], regionId: string): BodyRegion['side'] {
  const left = joints.filter((j) => j.endsWith('_l')).length;
  const right = joints.filter((j) => j.endsWith('_r')).length;
  if (left > 0 && right > 0) {
    throw new Error(
      `buildCanonicalBody: region "${regionId}" mixes _l and _r joints (${joints.join(', ')}) — ` +
        'a region has one side, or the mirroring rules cannot address it',
    );
  }
  return left > 0 ? 'left' : right > 0 ? 'right' : 'center';
}

/** TEXCOORD_0 for every vertex, in `documentToRiggedAsset`'s concatenation order. */
function readUvs(doc: Document, label: string): Float32Array {
  const parts: Float32Array[] = [];
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const uv = prim.getAttribute('TEXCOORD_0');
      if (!uv) {
        throw new Error(
          `${label}: mesh "${mesh.getName()}" has no TEXCOORD_0 — Track A's identity layer is ` +
            'UV-space (decals, shared atlases, palette swaps), so the canonical body must be ' +
            'UV-unwrapped; unwrap the source in your DCC and re-export before building it',
        );
      }
      const arr = uv.getArray() as Float32Array;
      parts.push(arr);
      total += arr.length;
    }
  }
  const out = new Float32Array(total);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/**
 * Turn a source rigged humanoid into the bundled canonical body: validate that
 * it really carries the UAL skeleton (REPORT what is missing — a body silently
 * fitted with half a skeleton is a roster of half-broken characters), derive
 * the regions, and write `body.glb` + `body.json`.
 *
 * The glb is copied BYTE-FOR-BYTE rather than re-encoded. It is the source of
 * truth for every character in the roster, so its hash should be the source
 * artist's bytes, not whatever our writer happened to emit today.
 */
export async function buildCanonicalBody(
  opts: BuildCanonicalBodyOptions,
): Promise<BuildCanonicalBodyResult> {
  const label = 'buildCanonicalBody';
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(opts.sourcePath);
  } catch (err) {
    throw new Error(`${label}: cannot read "${opts.sourcePath}" (${(err as Error).message})`);
  }
  const doc = await new NodeIO().readBinary(bytes);
  if (doc.getRoot().listSkins().length === 0) {
    throw new Error(
      `${label}: "${opts.sourcePath}" has no skin — Track A fits a RIGGED body, and the ` +
        'skeleton is the thing the whole roster shares; rig the source first ' +
        '(or run it through Track B) before building the canonical body',
    );
  }
  const asset = documentToRiggedAsset(doc, `${label}: "${opts.sourcePath}"`);
  const uvs = readUvs(doc, `${label}: "${opts.sourcePath}"`);
  if (uvs.length !== asset.vertexCount * 2) {
    throw new Error(
      `${label}: "${opts.sourcePath}" has ${uvs.length / 2} UVs for ${asset.vertexCount} ` +
        'vertices — every primitive must carry TEXCOORD_0',
    );
  }
  // "is this the right skeleton?" is asked BEFORE "are its bind matrices
  // consistent?": a body missing half the profile fails both, and the missing
  // joint names are the message that tells someone what to do about it
  const present = new Set(asset.jointNames);
  const missing = UAL_HUMANOID.core.filter((j) => !present.has(j));
  if (missing.length > 0) {
    throw new Error(
      `${label}: "${opts.sourcePath}" is missing ${missing.length} core UAL joint(s): ` +
        `${missing.join(', ')} — Track A shares ONE skeleton across the roster, so a body ` +
        'that does not carry it cannot be fitted; rename the joints to the UAL convention ' +
        '(anim/profile.ts) or pick a different source',
    );
  }
  assertRestRoundTrip(asset, `${label}: "${opts.sourcePath}"`);

  // dominant influence decides which region owns a vertex: a region is a
  // texture-space address, and a vertex belongs where most of its skin does
  const dominant = new Uint32Array(asset.vertexCount);
  for (let v = 0; v < asset.vertexCount; v++) {
    let best = -1;
    let bestW = -1;
    for (let k = 0; k < 4; k++) {
      const w = asset.weights[v * 4 + k];
      if (w > bestW) {
        bestW = w;
        best = asset.joints[v * 4 + k];
      }
    }
    dominant[v] = best;
  }

  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  const regions: BodyRegion[] = BODY_REGIONS.map((def) => {
    const owned = new Set(def.joints.map((j) => asset.jointNames.indexOf(j)));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let count = 0;
    for (let v = 0; v < asset.vertexCount; v++) {
      if (!owned.has(dominant[v])) continue;
      // UVs outside [0, 1] are clamped: the rect addresses the atlas PAGE, and
      // a tiled coordinate has no page to point at
      const u = clamp01(uvs[v * 2]);
      const w = clamp01(uvs[v * 2 + 1]);
      if (u < x0) x0 = u;
      if (u > x1) x1 = u;
      if (w < y0) y0 = w;
      if (w > y1) y1 = w;
      count++;
    }
    if (count === 0) {
      throw new Error(
        `${label}: no vertex is dominantly influenced by any of region "${def.id}"'s joints ` +
          `(${def.joints.join(', ')}) — the source body's skin does not cover that region, ` +
          'so a decal or bone mask aimed at it would land nowhere',
      );
    }
    return {
      id: def.id,
      joints: [...def.joints],
      uvRect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      side: sideOf(def.joints, def.id),
    };
  });

  // The material the region uvRects are authored against: the LARGEST
  // primitive's. Region ownership is by dominant joint, and limb/torso joints
  // dominate only body-mesh vertices — so the rects live in the body atlas's
  // UV space, and decals must paint THAT texture (not hair, not eyes).
  let bodyMaterial: string | undefined;
  let bodyMaterialVerts = -1;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const name = prim.getMaterial()?.getName();
      if (!name) continue;
      const verts = prim.getAttribute('POSITION')?.getCount() ?? 0;
      if (verts > bodyMaterialVerts) {
        bodyMaterialVerts = verts;
        bodyMaterial = name;
      }
    }
  }

  const bounds = boundsOf(asset.positions);
  const measured = bounds.max[1] - bounds.min[1];
  const heightM = opts.heightM ?? measured;
  if (!Number.isFinite(heightM) || heightM <= 0) {
    throw new Error(
      `${label}: "${opts.sourcePath}" stands ${measured} m tall — the canonical body must ` +
        'stand along +Y with its feet at Y=0 (D-012)',
    );
  }

  const body = parseWith(CanonicalBodySchema, {
    schemaVersion: SCHEMA_VERSION,
    id: opts.id,
    displayName: opts.displayName,
    license: opts.license,
    source: opts.source,
    skeleton: 'ual-humanoid',
    jointCount: asset.jointCount,
    vertexCount: asset.vertexCount,
    heightM,
    regions,
    ...(bodyMaterial ? { bodyMaterial } : {}),
  }, `canonical body "${opts.id}"`);

  await Deno.mkdir(opts.outDir, { recursive: true });
  const glbPath = `${opts.outDir}/${CANONICAL_BODY_FILE}`;
  const manifestPath = `${opts.outDir}/${CANONICAL_BODY_MANIFEST}`;
  await Deno.writeFile(glbPath, bytes);
  await Deno.writeTextFile(manifestPath, canonicalJson(body));
  return { body, glbPath, manifestPath };
}
