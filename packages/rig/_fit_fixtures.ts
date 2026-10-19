import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Fixtures for the roster fit (P3-T4). Nothing is checked in as binary: the
 * canonical body, its texture and every target mesh are built in memory, so the
 * tests are hermetic, GPU-free and network-free — and they have to be, because
 * the real Track A body (Quaternius Universal Base Characters, CC0) is not in
 * the repo yet and `buildCanonicalBody` must work on ANY UAL-skeleton glb.
 *
 * The body is `packages/anim/fixtures/_generate.ts`'s proportioned UAL humanoid
 * — 21 core joints, box segments rigidly bound to their own bone, feet on Y=0 —
 * plus the two things that generator lacks and Track A requires: UVs and a
 * texture. Each box segment gets its OWN UV island on a grid, which is what
 * makes the derived `BodyRegion.uvRect`s distinguishable (a body whose segments
 * all shared one island would let a wrong region rect pass every assertion).
 *
 * Targets are the same box-segment humanoid with different proportions and NO
 * skin, so a fit has a real silhouette to project onto and the taller/broader
 * assertions compare like with like.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { crc32 } from './_fixtures.ts';

export interface Proportions {
  legLen: number;
  torsoLen: number;
  armLen: number;
  headSize: number;
  /** shoulder half-width */
  width: number;
  /** limb half-thickness */
  thick: number;
}

/** The canonical body's own build: roughly 1.7 m, average proportions. */
export const BODY: Proportions = {
  legLen: 0.9,
  torsoLen: 0.55,
  armLen: 0.55,
  headSize: 0.22,
  width: 0.22,
  thick: 0.055,
};

/** Same build, scaled up: proves height drives Y and the joints follow. */
export const TALL: Proportions = {
  legLen: 1.17,
  torsoLen: 0.715,
  armLen: 0.715,
  headSize: 0.286,
  width: 0.286,
  thick: 0.0715,
};

/**
 * Same height, twice the build: every HORIZONTAL measure doubles (shoulder
 * width, arm length, limb thickness) while the vertical ones hold, so the
 * correct answer is a scale near [2, 1, 2] and a uniform fit is visibly wrong.
 */
export const BROAD: Proportions = { ...BODY, width: 0.44, armLen: 1.1, thick: 0.11 };

/**
 * A genuinely different build — short legs, short arms, big head. No single
 * per-axis scale can match it, which is the point: the surface error a fit
 * reports against this target has to be greater than zero or it is lying.
 */
export const CHUNKY: Proportions = {
  legLen: 0.5,
  torsoLen: 0.42,
  armLen: 0.38,
  headSize: 0.26,
  width: 0.3,
  thick: 0.09,
};

type Vec3 = [number, number, number];
type Bone = [name: string, parent: string, offset: Vec3];

/** The 21 UAL core joints, laid out from `p` (anim/fixtures/_generate.ts). */
export function skeleton(p: Proportions): Bone[] {
  const halfLeg = p.legLen / 2;
  const halfArm = p.armLen / 2;
  const t3 = p.torsoLen / 3;
  return [
    ['root', '', [0, 0, 0]],
    ['pelvis', 'root', [0, p.legLen, 0]],
    ['spine_01', 'pelvis', [0, t3 * 0.6, 0]],
    ['spine_02', 'spine_01', [0, t3, 0]],
    ['spine_03', 'spine_02', [0, t3, 0]],
    ['neck_01', 'spine_03', [0, t3 * 0.4 + t3, 0]],
    ['Head', 'neck_01', [0, p.headSize * 0.4, 0]],
    ['clavicle_l', 'spine_03', [p.width * 0.5, t3 * 0.8, 0]],
    ['upperarm_l', 'clavicle_l', [p.width * 0.5, 0, 0]],
    ['lowerarm_l', 'upperarm_l', [halfArm, 0, 0]],
    ['hand_l', 'lowerarm_l', [halfArm, 0, 0]],
    ['clavicle_r', 'spine_03', [-p.width * 0.5, t3 * 0.8, 0]],
    ['upperarm_r', 'clavicle_r', [-p.width * 0.5, 0, 0]],
    ['lowerarm_r', 'upperarm_r', [-halfArm, 0, 0]],
    ['hand_r', 'lowerarm_r', [-halfArm, 0, 0]],
    ['thigh_l', 'pelvis', [p.width * 0.5, 0, 0]],
    ['calf_l', 'thigh_l', [0, -halfLeg, 0]],
    ['foot_l', 'calf_l', [0, -halfLeg, 0]],
    ['thigh_r', 'pelvis', [-p.width * 0.5, 0, 0]],
    ['calf_r', 'thigh_r', [0, -halfLeg, 0]],
    ['foot_r', 'calf_r', [0, -halfLeg, 0]],
  ];
}

export function worldPositions(bones: Bone[]): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  for (const [name, parent, off] of bones) {
    const base = parent ? out.get(parent)! : [0, 0, 0] as Vec3;
    out.set(name, [base[0] + off[0], base[1] + off[1], base[2] + off[2]]);
  }
  return out;
}

interface Segment {
  joint: string;
  from: Vec3;
  to: Vec3;
  half: number;
}

/** One box per body part, each rigidly bound to the joint that owns it. */
export function segments(p: Proportions, w: Map<string, Vec3>): Segment[] {
  const seg = (joint: string, from: string, to: string, half = p.thick): Segment => ({
    joint,
    from: w.get(from)!,
    to: w.get(to)!,
    half,
  });
  const at = (joint: string, c: string, half: number): Segment => ({
    joint,
    from: w.get(c)!,
    to: w.get(c)!,
    half,
  });
  return [
    seg('pelvis', 'pelvis', 'spine_01', p.width * 0.7),
    seg('spine_01', 'spine_01', 'spine_02', p.width * 0.65),
    seg('spine_02', 'spine_02', 'spine_03', p.width * 0.6),
    seg('spine_03', 'spine_03', 'neck_01', p.width * 0.55),
    seg('neck_01', 'neck_01', 'Head', p.thick),
    at('Head', 'Head', p.headSize / 2),
    seg('clavicle_l', 'clavicle_l', 'upperarm_l'),
    seg('upperarm_l', 'upperarm_l', 'lowerarm_l'),
    seg('lowerarm_l', 'lowerarm_l', 'hand_l'),
    at('hand_l', 'hand_l', p.thick * 1.2),
    seg('clavicle_r', 'clavicle_r', 'upperarm_r'),
    seg('upperarm_r', 'upperarm_r', 'lowerarm_r'),
    seg('lowerarm_r', 'lowerarm_r', 'hand_r'),
    at('hand_r', 'hand_r', p.thick * 1.2),
    seg('thigh_l', 'thigh_l', 'calf_l', p.thick * 1.3),
    seg('calf_l', 'calf_l', 'foot_l'),
    at('foot_l', 'foot_l', p.thick * 1.4),
    seg('thigh_r', 'thigh_r', 'calf_r', p.thick * 1.3),
    seg('calf_r', 'calf_r', 'foot_r'),
    at('foot_r', 'foot_r', p.thick * 1.4),
  ];
}

const FACES: { n: Vec3; v: number[][] }[] = [
  { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
];

interface BoxMesh {
  positions: number[];
  normals: number[];
  uvs: number[];
  joints: number[];
  weights: number[];
  indices: number[];
}

/**
 * Box segments into flat arrays. Every segment claims one cell of a 5x5 UV
 * grid, inset by a texel so islands never touch — the same discipline a real
 * atlas needs, and the reason a region's derived rect is meaningful.
 */
function boxes(
  segs: Segment[],
  jointIndex: (joint: string) => number,
): BoxMesh {
  const m: BoxMesh = {
    positions: [],
    normals: [],
    uvs: [],
    joints: [],
    weights: [],
    indices: [],
  };
  const grid = 5;
  const inset = 0.01;
  segs.forEach((s, si) => {
    const cx = (s.from[0] + s.to[0]) / 2;
    const cy = (s.from[1] + s.to[1]) / 2;
    const cz = (s.from[2] + s.to[2]) / 2;
    const hx = Math.max(Math.abs(s.to[0] - s.from[0]) / 2, s.half);
    const hy = Math.max(Math.abs(s.to[1] - s.from[1]) / 2, s.half);
    const hz = Math.max(Math.abs(s.to[2] - s.from[2]) / 2, s.half);
    const ji = jointIndex(s.joint);
    const u0 = (si % grid) / grid + inset;
    const v0 = Math.floor(si / grid) / grid + inset;
    const span = 1 / grid - inset * 2;
    const base = m.positions.length / 3;
    for (const f of FACES) {
      f.v.forEach((v, k) => {
        m.positions.push(cx + v[0] * hx, cy + v[1] * hy, cz + v[2] * hz);
        m.normals.push(...f.n);
        // the four corners of this segment's island, so the island bounds are
        // exactly the cell the segment was given
        m.uvs.push(u0 + (k === 1 || k === 2 ? span : 0), v0 + (k >= 2 ? span : 0));
        m.joints.push(ji, 0, 0, 0);
        m.weights.push(1, 0, 0, 0);
      });
    }
    for (let fi = 0; fi < 6; fi++) {
      const o = base + fi * 4;
      m.indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
  });
  return m;
}

// ---------------------------------------------------------------------------
// A real PNG, so the body carries a real texture through the fit
// ---------------------------------------------------------------------------

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(name, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A 4x4 RGBA PNG — small, valid, and decodable by anything downstream. */
export async function tinyPng(): Promise<Uint8Array> {
  const size = 4;
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 4;
      raw[o] = (x * 60) & 0xff;
      raw[o + 1] = (y * 60) & 0xff;
      raw[o + 2] = 128;
      raw[o + 3] = 255;
    }
  }
  const deflated = new Uint8Array(
    await new Response(
      new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer(),
  );
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The glbs
// ---------------------------------------------------------------------------

export interface BodyOptions {
  /** drop TEXCOORD_0, to prove buildCanonicalBody names the fix */
  withoutUvs?: boolean;
  /** drop the skin, to prove it refuses an unrigged source */
  withoutSkin?: boolean;
  /** leave one core joint out, to prove it REPORTS what is missing */
  omitJoints?: string[];
}

/** The canonical body: UAL-skinned, UV-mapped, textured, feet on Y=0. */
export async function buildBodyGlb(
  p: Proportions = BODY,
  opts: BodyOptions = {},
): Promise<Uint8Array> {
  const omit = new Set(opts.omitJoints ?? []);
  const bones = skeleton(p).filter(([name]) => !omit.has(name));
  const world = worldPositions(skeleton(p));
  const index = new Map(bones.map(([name], i) => [name, i]));
  const segs = segments(p, world).filter((s) => index.has(s.joint));
  const m = boxes(segs, (j) => index.get(j)!);

  const doc = new Document();
  const buffer = doc.createBuffer();
  // omitting a joint re-parents its children onto the nearest SURVIVING
  // ancestor, with the offset recomputed from world positions — an omitted
  // joint must leave a smaller-but-consistent skeleton, or the missing-joint
  // test would be passing on a broken bind pose instead of on the joint names
  const parentOf = new Map(skeleton(p).map(([name, parent]) => [name, parent]));
  const surviving = (name: string): string => {
    let up = parentOf.get(name) ?? '';
    while (up && omit.has(up)) up = parentOf.get(up) ?? '';
    return up;
  };
  const nodes = new Map<string, ReturnType<Document['createNode']>>();
  for (const [name] of bones) {
    const parent = surviving(name);
    const here = world.get(name)!;
    const base = parent ? world.get(parent)! : [0, 0, 0] as Vec3;
    const n = doc.createNode(name).setTranslation([
      here[0] - base[0],
      here[1] - base[1],
      here[2] - base[2],
    ]);
    nodes.set(name, n);
    if (parent) nodes.get(parent)!.addChild(n);
  }

  const prim = doc.createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(m.positions)).setBuffer(
        buffer,
      ),
    )
    .setAttribute(
      'NORMAL',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(m.normals)).setBuffer(buffer),
    )
    .setIndices(
      doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(m.indices)).setBuffer(buffer),
    );
  if (!opts.withoutUvs) {
    prim.setAttribute(
      'TEXCOORD_0',
      doc.createAccessor().setType('VEC2').setArray(new Float32Array(m.uvs)).setBuffer(buffer),
    );
  }
  if (!opts.withoutSkin) {
    prim.setAttribute(
      'JOINTS_0',
      doc.createAccessor().setType('VEC4').setArray(new Uint8Array(m.joints)).setBuffer(buffer),
    ).setAttribute(
      'WEIGHTS_0',
      doc.createAccessor().setType('VEC4').setArray(new Float32Array(m.weights)).setBuffer(buffer),
    );
  }

  const texture = doc.createTexture('skin').setImage(await tinyPng()).setMimeType('image/png');
  prim.setMaterial(doc.createMaterial('body').setBaseColorTexture(texture));

  const mesh = doc.createMesh('body').addPrimitive(prim);
  const meshNode = doc.createNode('body').setMesh(mesh);
  const scene = doc.createScene('scene');
  if (!opts.withoutSkin) {
    // pure-translation rest frames, so IBM = T(-world) exactly and the source
    // body round-trips its own bind pose
    const ibm = new Float32Array(bones.length * 16);
    bones.forEach(([name], i) => {
      const w = world.get(name)!;
      ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -w[0], -w[1], -w[2], 1], i * 16);
    });
    const skin = doc.createSkin('rig')
      .setSkeleton(nodes.get('root')!)
      .setInverseBindMatrices(
        doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer),
      );
    for (const [name] of bones) skin.addJoint(nodes.get(name)!);
    meshNode.setSkin(skin);
  }
  scene.addChild(nodes.get('root')!).addChild(meshNode);
  return await new NodeIO().writeBinary(doc);
}

export interface TargetOptions {
  /**
   * Drop the arm segments — the image-to-3D failure where a character's arms
   * fuse into its torso. The silhouette bands then read a barrel where the body
   * has a waist, the fit widens the body to match, and the arm joints land
   * outside the target: the tear `strayJoints` is for.
   */
  withoutArms?: boolean;
}

/** A target mesh: the same box humanoid at other proportions, with NO skin. */
export async function buildTargetGlb(
  p: Proportions,
  opts: TargetOptions = {},
): Promise<Uint8Array> {
  const bones = skeleton(p);
  const world = worldPositions(bones);
  const segs = segments(p, world).filter((s) =>
    !opts.withoutArms || !/clavicle|arm|hand/.test(s.joint)
  );
  const m = boxes(segs, () => 0);
  const doc = new Document();
  const buffer = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(m.positions)).setBuffer(
        buffer,
      ),
    )
    .setAttribute(
      'NORMAL',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(m.normals)).setBuffer(buffer),
    )
    .setIndices(
      doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(m.indices)).setBuffer(buffer),
    );
  const mesh = doc.createMesh('target').addPrimitive(prim);
  doc.createScene('scene').addChild(doc.createNode('target').setMesh(mesh));
  return await new NodeIO().writeBinary(doc);
}

/**
 * A featureless box standing on Y=0 — the shape a bad image-to-3D run produces
 * when it fuses the whole silhouette into one blob.
 *
 * As a fit target it is deliberately degenerate, and it tears in a specific,
 * nameable way: every silhouette band of a slab is as wide as the slab, so the
 * band ratios are set by the body's NARROW bands (waist, hips) while the body's
 * X extent is set by its arm span. The fit widens the body to match a torso and
 * throws the hands metres outside the target — which is exactly what
 * `strayJoints` exists to say out loud instead of writing a torn body silently.
 */
export async function buildBoxGlb(w = 0.6, h = 1.7, d = 0.3): Promise<Uint8Array> {
  const m = boxes(
    [{ joint: 'x', from: [-w / 2, 0, -d / 2], to: [w / 2, h, d / 2], half: 0 }],
    () => 0,
  );
  const doc = new Document();
  const buffer = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(m.positions)).setBuffer(
        buffer,
      ),
    )
    .setIndices(
      doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(m.indices)).setBuffer(buffer),
    );
  const mesh = doc.createMesh('box').addPrimitive(prim);
  doc.createScene('scene').addChild(doc.createNode('box').setMesh(mesh));
  return await new NodeIO().writeBinary(doc);
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export interface FitCase {
  dir: string;
  sourcePath: string;
  bodyPath: string;
  bodyManifestPath: string;
  targetPath: string;
  outPath: string;
}

/** Build the canonical body and a target into a fresh temp dir. */
export async function stageFitCase(
  target: Uint8Array,
  bodyBytes?: Uint8Array,
): Promise<FitCase> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'spritebook-fit-'));
  const sourcePath = `${dir}/source.glb`;
  await fs.writeFile(sourcePath, bodyBytes ?? await buildBodyGlb());
  const targetPath = `${dir}/target.glb`;
  await fs.writeFile(targetPath, target);
  return {
    dir,
    sourcePath,
    bodyPath: `${dir}/body/body.glb`,
    bodyManifestPath: `${dir}/body/body.json`,
    targetPath,
    outPath: `${dir}/fitted.glb`,
  };
}

/** The manifest fields every fixture body shares. */
export const BODY_META = {
  id: 'fixture-body',
  displayName: 'Fixture body',
  license: 'CC0-1.0',
  source: 'packages/rig/_fit_fixtures.ts',
} as const;
