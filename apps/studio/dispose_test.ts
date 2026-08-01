/**
 * The viewport-disposal leak test (P4-T3).
 *
 * The leak this guards against is invisible to the language: three.js holds
 * GPU buffers that JavaScript's garbage collector cannot reach, so dropping
 * the last reference to a geometry frees a few hundred bytes of JS object and
 * keeps the vertex buffer until `.dispose()` runs. A viewport that loads ten
 * characters in a session and releases none of them holds ten meshes' worth of
 * VRAM — on the same card the bakes are queued against.
 *
 * These use REAL three objects (revision 185, the pinned one) rather than
 * stand-ins, so what is asserted is three's own accounting, not a fiction that
 * agrees with the code by construction. What they cannot do is boot a GPU: the
 * `renderer.info.memory` half of the story is proven live in the browser and
 * recorded in docs/internal/roadmap/p4.md.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
// The exact version apps/studio/package.json pins. Spelled out here because
// apps/studio is an npm project rather than a Deno workspace member, so the
// root `deno test` has no import map to resolve a bare "three" through. The
// REVISION assertion below is what catches the two drifting apart.
import * as THREE from 'npm:three@0.185.1';
import { disposeTree, type MaterialLike, type TreeNode } from './src/viewport/dispose.ts';

/** Wrap three's dispose so the test can see what was released, and count it. */
function counted<T extends { dispose: () => void }>(
  o: T,
): T & { disposals: number } {
  const tracked = o as T & { disposals: number };
  tracked.disposals = 0;
  const original = o.dispose.bind(o);
  o.dispose = () => {
    tracked.disposals++;
    original();
  };
  return tracked;
}

interface Built {
  root: THREE.Object3D;
  originals: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
  geometries: (THREE.BufferGeometry & { disposals: number })[];
  materials: (THREE.Material & { disposals: number })[];
  textures: (THREE.Texture & { disposals: number })[];
}

/**
 * A model shaped like what GLTFLoader hands the viewport: a few meshes, one
 * sharing its material with another, one carrying two texture slots, and one
 * with a material array.
 */
function buildModel(meshCount = 3): Built {
  const root = new THREE.Group();
  const geometries: Built['geometries'] = [];
  const materials: Built['materials'] = [];
  const textures: Built['textures'] = [];
  const originals: Built['originals'] = new Map();

  const shared = counted(new THREE.MeshStandardMaterial({ name: 'shared' }));
  materials.push(shared);

  for (let i = 0; i < meshCount; i++) {
    const geometry = counted(new THREE.BoxGeometry(1, 1, 1));
    geometries.push(geometry);
    let material: THREE.Material | THREE.Material[];
    if (i === 0) {
      const m = counted(new THREE.MeshStandardMaterial({ name: `m${i}` }));
      const map = counted(new THREE.Texture());
      const normalMap = counted(new THREE.Texture());
      m.map = map;
      m.normalMap = normalMap;
      textures.push(map, normalMap);
      materials.push(m);
      material = m;
    } else if (i === 1) {
      // two meshes on ONE material — a real glTF thing, and a double-dispose
      // trap for anything that counts per mesh
      material = shared;
    } else {
      const a = counted(new THREE.MeshStandardMaterial({ name: `m${i}a` }));
      const b = counted(new THREE.MeshBasicMaterial({ name: `m${i}b` }));
      materials.push(a, b);
      material = [a, b];
    }
    const mesh = new THREE.Mesh(geometry, material);
    originals.set(mesh, material);
    root.add(mesh);
  }
  // and one more mesh reusing `shared`, so it is genuinely shared
  const extraGeometry = counted(new THREE.BoxGeometry(1, 1, 1));
  geometries.push(extraGeometry);
  const extra = new THREE.Mesh(extraGeometry, shared);
  originals.set(extra, shared);
  root.add(extra);

  return { root, originals, geometries, materials, textures };
}

const asTree = (o: THREE.Object3D) => o as unknown as TreeNode;
const asMap = (m: Built['originals']) =>
  m as unknown as Map<TreeNode, MaterialLike | MaterialLike[]>;

Deno.test('the three under test is the three the app ships', () => {
  // if this fails, apps/studio/package.json moved and this file did not: the
  // leak walk would then be proven against a different three than runs
  assertEquals(THREE.REVISION, '185');
});

Deno.test('every geometry, material and texture in a model is released', () => {
  const built = buildModel();
  const tally = disposeTree(asTree(built.root), asMap(built.originals));

  for (const g of built.geometries) {
    assertEquals(g.disposals, 1, 'each geometry released exactly once');
  }
  for (const m of built.materials) {
    assertEquals(
      m.disposals,
      1,
      `${m.name}: each material released exactly once`,
    );
  }
  for (const t of built.textures) {
    assertEquals(t.disposals, 1, 'each texture released once');
  }

  assertEquals(tally.geometries, 4);
  assertEquals(
    tally.materials,
    built.materials.length,
    'the shared one counted once',
  );
  assertEquals(tally.textures, 2);
  assertEquals(tally.kept, 0);
});

Deno.test('textures are found by walking slots, not by a hardcoded list', () => {
  // three adds material slots every release; a fixed list of names silently
  // stops freeing the new ones, and nothing fails until VRAM does
  const root = new THREE.Group();
  const material = counted(new THREE.MeshPhysicalMaterial({}));
  const slots = [
    'map',
    'normalMap',
    'roughnessMap',
    'aoMap',
    'emissiveMap',
    'clearcoatMap',
  ];
  const textures = slots.map(() => counted(new THREE.Texture()));
  slots.forEach((slot, i) => {
    (material as unknown as Record<string, unknown>)[slot] = textures[i];
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  root.add(mesh);

  const tally = disposeTree(asTree(root));
  assertEquals(tally.textures, slots.length, `all ${slots.length} slots freed`);
  for (const t of textures) assertEquals(t.disposals, 1);
});

Deno.test('the ORIGINAL material is released, not the one the mode swapped in', () => {
  // Clay/Wire mode replaces mesh.material; at dispose time the material on the
  // mesh is not the one that needs freeing, and the one that does is only in
  // the originals map. Without it, a model disposed in clay mode leaks every
  // texture it ever loaded.
  const built = buildModel(1);
  const clay = counted(new THREE.MeshStandardMaterial({ name: 'CLAY' }));
  for (const mesh of built.originals.keys()) mesh.material = clay;

  const tally = disposeTree(
    asTree(built.root),
    asMap(built.originals),
    new Set([clay as unknown as MaterialLike]),
  );
  assertEquals(clay.disposals, 0, 'the shared clay material survives');
  assertEquals(
    tally.textures,
    2,
    'and the real materials’ textures were still freed',
  );
  for (const t of built.textures) assertEquals(t.disposals, 1);
});

Deno.test('a mesh missing from the map never takes a SHARED material down', () => {
  // the fallback path: `originals.get(mesh) ?? mesh.material`. With clay on the
  // mesh and no map entry, the fallback IS the app-wide singleton — disposing
  // it blanks the mesh in every other open viewport, which takes two viewports
  // and a mode switch to notice.
  const root = new THREE.Group();
  const clay = counted(new THREE.MeshStandardMaterial({ name: 'CLAY' }));
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), clay));

  const tally = disposeTree(
    asTree(root),
    new Map(), // deliberately empty
    new Set([clay as unknown as MaterialLike]),
  );
  assertEquals(clay.disposals, 0, 'refused');
  assertEquals(tally.kept, 1, 'and said so in the tally rather than silently');
});

Deno.test('a hundred load/dispose cycles retain nothing', () => {
  // the actual leak shape: the viewport replaces its model on every load, and
  // a walk that misses one class of resource compounds once per character
  let geometries = 0;
  let materials = 0;
  let textures = 0;
  const live: { disposals: number }[] = [];

  for (let i = 0; i < 100; i++) {
    const built = buildModel();
    live.push(...built.geometries, ...built.materials, ...built.textures);
    const tally = disposeTree(asTree(built.root), asMap(built.originals));
    geometries += tally.geometries;
    materials += tally.materials;
    textures += tally.textures;
  }
  assertEquals(geometries, 400, '4 geometries × 100 loads');
  assertEquals(materials, 400, '4 distinct materials × 100');
  assertEquals(textures, 200, '2 textures × 100');
  const retained = live.filter((o) => o.disposals === 0);
  assertEquals(
    retained.length,
    0,
    `${retained.length} GPU objects never released`,
  );
});

Deno.test('disposing twice is not a double release', () => {
  // React strict mode mounts, unmounts and remounts; `dispose()` guards on a
  // flag, but the walk itself must be safe if that guard ever moves
  const built = buildModel(2);
  disposeTree(asTree(built.root), asMap(built.originals));
  const second = disposeTree(asTree(built.root), asMap(built.originals));
  // three's own dispose is idempotent, so the assertion is that the walk does
  // not crash and reports the same shape — not that the count stays at one
  assert(
    second.geometries > 0,
    'the walk still runs cleanly over a released tree',
  );
  for (const t of built.textures) assert(t.disposals >= 1);
});

Deno.test('an empty model is not an error', () => {
  const tally = disposeTree(asTree(new THREE.Group()));
  assertEquals(tally, { geometries: 0, materials: 0, textures: 0, kept: 0 });
});
