/**
 * The viewport's disposal walk, as a function nothing has to boot a GPU to test.
 *
 * three.js allocates GPU objects that JavaScript's garbage collector cannot
 * see: dropping the last reference to a BufferGeometry frees a few hundred
 * bytes of JS and leaks the vertex buffer until `.dispose()` is called. A
 * viewport that loads ten characters in a session and disposes none of them
 * holds ten meshes' worth of VRAM — on the same card the bakes need.
 *
 * So this walk is the thing that must be right, and it is deliberately not a
 * method: it takes a tree and returns a tally, which is what makes "load and
 * dispose a hundred times, then check nothing was retained" a suite test
 * instead of a thing someone eyeballs in a browser once.
 *
 * Structural types rather than three's, for the same reason the viewport class
 * exists at all (the skill's stance): three stays behind one seam. The test
 * feeds it REAL three objects, so the structure is not a fiction.
 */

export interface DisposableThing {
  dispose(): void;
}

export interface MaterialLike extends DisposableThing {
  [key: string]: unknown;
}

export interface TreeNode {
  traverse(cb: (o: TreeNode) => void): void;
  isMesh?: boolean;
  geometry?: DisposableThing;
  material?: MaterialLike | MaterialLike[];
}

export interface DisposalTally {
  geometries: number;
  materials: number;
  textures: number;
  /** materials skipped because they are shared and outlive this model */
  kept: number;
}

function isTexture(v: unknown): v is DisposableThing {
  return typeof v === 'object' && v !== null &&
    (v as { isTexture?: boolean }).isTexture === true;
}

/**
 * Release every GPU resource under `root`.
 *
 * `originals` maps a mesh to the material it arrived with, because the view
 * modes swap `mesh.material` to a shared clay or wireframe material — so at
 * dispose time the material hanging off the mesh is often NOT the one that
 * needs releasing, and the one that does is only in this map.
 *
 * `keep` is the guard that makes that safe in the other direction: the shared
 * clay/wire materials are module-level singletons behind every viewport in the
 * app, and disposing one would blank the mesh in every other open viewport. A
 * mesh missing from `originals` used to fall through to `mesh.material`, which
 * is exactly the shared singleton — a bug that needs two viewports and a mode
 * switch to see, and is invisible with one.
 *
 * Textures are found by walking each material's own properties rather than a
 * fixed list of slot names (`map`, `normalMap`, …): three adds slots every
 * release, and a hardcoded list silently stops freeing the new ones.
 */
export function disposeTree(
  root: TreeNode,
  originals?: Map<TreeNode, MaterialLike | MaterialLike[]>,
  keep: ReadonlySet<MaterialLike> = new Set(),
): DisposalTally {
  const tally: DisposalTally = {
    geometries: 0,
    materials: 0,
    textures: 0,
    kept: 0,
  };
  // one material can be shared by several meshes of the same model; disposing
  // it twice is harmless in three but would double-count the tally, and the
  // tally is what the leak test reads
  const seenMaterials = new Set<MaterialLike>();
  const seenTextures = new Set<DisposableThing>();

  root.traverse((o) => {
    if (o.isMesh !== true) return;
    if (o.geometry) {
      o.geometry.dispose();
      tally.geometries++;
    }
    const material = originals?.get(o) ?? o.material;
    if (material === undefined) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      if (!m || seenMaterials.has(m)) continue;
      seenMaterials.add(m);
      if (keep.has(m)) {
        tally.kept++;
        continue;
      }
      for (const value of Object.values(m)) {
        if (!isTexture(value) || seenTextures.has(value)) continue;
        seenTextures.add(value);
        value.dispose();
        tally.textures++;
      }
      m.dispose();
      tally.materials++;
    }
  });
  return tally;
}
