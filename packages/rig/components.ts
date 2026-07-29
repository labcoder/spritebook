/**
 * Connected components of a mesh, and why a rig cares (P3-T3).
 *
 * A skinning model predicts ONE skeleton and weights every vertex against it.
 * When the geometry is several DETACHED shells — a robot whose hands float
 * beside its arms, a character with a separate prop — no joint placement can
 * make a chain drive a shell it does not touch, and the deform check reports
 * tearing that no amount of hinting will repair.
 *
 * Measured (spikes/trellis2/HINTS-REPORT.md): `robot-astro` has floating hands
 * and its aggregate torn fraction only moved 18.50% → 15.01% under hints, while
 * the single-shell `painted-mermaid` moved 12.69% → 4.89% from offsets of the
 * same size. That ceiling was predictable from the geometry alone, before
 * ~90 s of GPU, which is what this check exists to say.
 *
 * ## Welding by POSITION first is not optional
 *
 * The border's `weld` merges vertices identical in ALL attributes, so a UV seam
 * legitimately leaves two vertices at the same point — a sphere with a texture
 * seam is one shell stored as a split index ring. Walking raw indices would
 * report those as separate components and fire on every textured character.
 * So vertices are first grouped by quantized position, and adjacency is unioned
 * over those groups: what this counts is shells you could not walk between, not
 * index-buffer artifacts.
 *
 * The quantum is relative to the mesh's own extent (1e-6), well under any real
 * gap and well over float noise from the border's rescale.
 *
 * ## "More than one component" is the wrong question
 *
 * Every generated mesh is full of specks. Measured on the three subjects, all
 * of them multi-component and only one of them actually broken:
 *
 *   bulma    73 shells, largest 92.4%, next 1.7%   - one body plus debris
 *   mermaid  41 shells, largest 89.5%, next 4.0%   - one body plus jellyfish
 *   astro    76 shells, largest 60.4%, next 20.0%  - TWO bodies (floating hands)
 *
 * So the flag counts SIGNIFICANT shells: those holding at least
 * `SIGNIFICANT_FRACTION` of the welded vertices. A shell that big is a
 * limb-or-larger chunk the skeleton has to drive; anything smaller is an
 * accessory that rides along. 10% sits between the largest decoration observed
 * (4.0%) and the smallest genuine second body (20.0%) — three subjects, and
 * the constant says so rather than implying precision it does not have.
 */

import { NodeIO } from '@gltf-transform/core';

/** One detached shell. */
export interface MeshComponent {
  /** welded vertex positions in this shell */
  vertexCount: number;
  /** share of the mesh's welded vertices */
  fraction: number;
}

export interface ComponentReport {
  /** shells, largest first */
  components: MeshComponent[];
  /** welded vertex count — the denominator of every `fraction` */
  weldedVertices: number;
  /** shells at or above SIGNIFICANT_FRACTION — the ones a skeleton must drive */
  significant: MeshComponent[];
}

const POSITION_QUANTUM = 1e-6;

/** A shell holding at least this share of the mesh is a body, not a decoration. */
export const SIGNIFICANT_FRACTION = 0.1;

/**
 * Group vertices by position, union across triangle edges, and return the
 * shells largest-first. `positions` is xyz per vertex; `indices` is a triangle
 * list into it.
 */
export function connectedComponents(
  positions: Float32Array,
  indices: Uint32Array,
): ComponentReport {
  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount === 0) return { components: [], weldedVertices: 0, significant: [] };

  // extent-relative quantum: a fixed epsilon would be meaningless across a
  // 1.65 m character and a unit-box mesh
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < positions.length; i++) {
    if (positions[i] < min) min = positions[i];
    if (positions[i] > max) max = positions[i];
  }
  const extent = Math.max(max - min, Number.EPSILON);
  const q = extent * POSITION_QUANTUM;

  // welded id per raw vertex
  const key = new Map<string, number>();
  const welded = new Int32Array(vertexCount);
  let weldedCount = 0;
  for (let v = 0; v < vertexCount; v++) {
    const k = `${Math.round(positions[v * 3] / q)},${Math.round(positions[v * 3 + 1] / q)},${
      Math.round(positions[v * 3 + 2] / q)
    }`;
    let id = key.get(k);
    if (id === undefined) {
      id = weldedCount++;
      key.set(k, id);
    }
    welded[v] = id;
  }

  const parent = new Int32Array(weldedCount);
  for (let i = 0; i < weldedCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = welded[indices[t]], b = welded[indices[t + 1]], c = welded[indices[t + 2]];
    union(a, b);
    union(b, c);
  }

  const sizes = new Map<number, number>();
  for (let i = 0; i < weldedCount; i++) {
    const r = find(i);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  const components = [...sizes.values()]
    .sort((x, y) => y - x)
    .map((vertexCount) => ({ vertexCount, fraction: vertexCount / weldedCount }));
  return {
    components,
    weldedVertices: weldedCount,
    significant: components.filter((c) => c.fraction >= SIGNIFICANT_FRACTION),
  };
}

/**
 * The warn text for a mesh in several SUBSTANTIAL pieces, or null.
 *
 * Null for one big shell plus debris, which is every healthy generated
 * character — see the module docstring for why the raw count is not the signal.
 */
export function disconnectedWarning(report: ComponentReport): string | null {
  const big = report.significant;
  if (big.length <= 1) return null;
  const shown = big.slice(0, 5)
    .map((c) => `${c.vertexCount.toLocaleString()} verts (${(c.fraction * 100).toFixed(1)}%)`)
    .join(', ');
  const rest = big.length > 5 ? `, and ${big.length - 5} more` : '';
  const debris = report.components.length - big.length;
  return `this mesh is ${big.length} SUBSTANTIAL detached pieces: ${shown}${rest}` +
    `${debris > 0 ? ` (plus ${debris} smaller fragments, which are normal)` : ''}. A rig ` +
    `predicts ONE skeleton and weights every vertex to it, so a piece no joint runs through can ` +
    `only be carried rigidly by whichever joint is nearest - which the deform check then reports ` +
    `as tearing, and which no joint placement or hint can repair. Measured: a two-body mesh ` +
    `improved 18.5% -> 15.0% under auto-hints where a single-body one improved 12.7% -> 4.9%. ` +
    `Join the pieces before rigging if they should move together.`;
}

/**
 * `connectedComponents` for a glb on disk, in world space.
 *
 * Positions ride their node transforms — two shells can be coincident in local
 * space and metres apart once placed, and it is the placed geometry a skeleton
 * has to reach.
 */
export async function componentsOfFile(path: string): Promise<ComponentReport> {
  const doc = await new NodeIO().readBinary(await Deno.readFile(path));
  const pos: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const p = prim.getAttribute('POSITION');
      if (!p) continue;
      const a = p.getArray()!;
      for (let i = 0; i < a.length; i += 3) {
        const x = a[i], y = a[i + 1], z = a[i + 2];
        pos.push(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        );
      }
      const ind = prim.getIndices();
      // an unindexed primitive is a flat triangle soup: 0,1,2,3,...
      if (ind) {
        for (const v of ind.getArray()!) idx.push(base + v);
      } else {
        for (let v = 0; v < a.length / 3; v++) idx.push(base + v);
      }
      base += a.length / 3;
    }
  }
  return connectedComponents(Float32Array.from(pos), Uint32Array.from(idx));
}
