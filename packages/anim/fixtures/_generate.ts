import { promises as fs } from 'node:fs';
/**
 * Anim fixture generator (deterministic; run once, files are checked in):
 * THREE rigged humanoids of deliberately different proportions, all on the
 * UAL-humanoid joint names (subset — 21 core joints), so retarget acceptance
 * ("a UAL walk keeps feet planted on three different-proportioned humanoids")
 * runs hermetically in CI. Partial profile coverage is intentional: the
 * missing finger/toe joints exercise unmapped-joint REPORTING (never guessing).
 *
 * Bodies are box segments rigidly skinned to their bone (like the style
 * package's asymmetric fixture, but a full biped). Feet rest on Y=0.
 *
 *   node tools/run.mjs \
 *     packages/anim/fixtures/_generate.ts
 */
import { Document, NodeIO } from '@gltf-transform/core';

const here = new URL('.', import.meta.url);
const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');

interface Proportions {
  name: string;
  legLen: number; // thigh+calf combined
  torsoLen: number; // pelvis->neck
  armLen: number; // upperarm+lowerarm
  headSize: number;
  width: number; // shoulder half-width
  thick: number; // limb half-thickness
}

const BODIES: Proportions[] = [
  {
    name: 'normal',
    legLen: 0.9,
    torsoLen: 0.55,
    armLen: 0.55,
    headSize: 0.22,
    width: 0.22,
    thick: 0.055,
  },
  {
    name: 'tall-thin',
    legLen: 1.15,
    torsoLen: 0.68,
    armLen: 0.7,
    headSize: 0.2,
    width: 0.18,
    thick: 0.04,
  },
  {
    name: 'short-chunky',
    legLen: 0.5,
    torsoLen: 0.42,
    armLen: 0.38,
    headSize: 0.26,
    width: 0.3,
    thick: 0.09,
  },
];

/** joint name -> [parent, localOffset xyz] — built per proportions. */
function skeleton(p: Proportions): Array<[string, string, [number, number, number]]> {
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

/** world position of each joint (skeleton offsets are pure translations). */
function worldPositions(
  bones: Array<[string, string, [number, number, number]]>,
): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  for (const [name, parent, off] of bones) {
    const base = parent ? out.get(parent)! : [0, 0, 0] as [number, number, number];
    out.set(name, [base[0] + off[0], base[1] + off[1], base[2] + off[2]]);
  }
  return out;
}

/** A box between two points (or around one point), rigidly bound to `joint`. */
interface Segment {
  joint: string;
  from: [number, number, number];
  to: [number, number, number];
  half: number;
}

function segments(p: Proportions): (w: Map<string, [number, number, number]>) => Segment[] {
  return (w) => {
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
      at('Head', 'Head', p.headSize / 2),
      seg('upperarm_l', 'upperarm_l', 'lowerarm_l'),
      seg('lowerarm_l', 'lowerarm_l', 'hand_l'),
      at('hand_l', 'hand_l', p.thick * 1.2),
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
  };
}

function buildBody(p: Proportions): Uint8Array | Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const bones = skeleton(p);
  const world = worldPositions(bones);

  // joint nodes
  const nodes = new Map<string, ReturnType<Document['createNode']>>();
  for (const [name, parent, off] of bones) {
    const n = doc.createNode(name).setTranslation(off);
    nodes.set(name, n);
    if (parent) nodes.get(parent)!.addChild(n);
  }

  // geometry: one box per segment, all in one primitive, rigid weights
  const jointIndex = new Map(bones.map(([name], i) => [name, i]));
  const positions: number[] = [];
  const normals: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const indices: number[] = [];
  const FACES: Array<{ n: [number, number, number]; v: number[][] }> = [
    { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  ];
  for (const s of segments(p)(world)) {
    const cx = (s.from[0] + s.to[0]) / 2;
    const cy = (s.from[1] + s.to[1]) / 2;
    const cz = (s.from[2] + s.to[2]) / 2;
    const hx = Math.max(Math.abs(s.to[0] - s.from[0]) / 2, s.half);
    const hy = Math.max(Math.abs(s.to[1] - s.from[1]) / 2, s.half);
    const hz = Math.max(Math.abs(s.to[2] - s.from[2]) / 2, s.half);
    const ji = jointIndex.get(s.joint)!;
    const base = positions.length / 3;
    for (const f of FACES) {
      for (const v of f.v) {
        positions.push(cx + v[0] * hx, cy + v[1] * hy, cz + v[2] * hz);
        normals.push(...f.n);
        joints.push(ji, 0, 0, 0);
        weights.push(1, 0, 0, 0);
      }
    }
    for (let fi = 0; fi < 6; fi++) {
      const o = base + fi * 4;
      indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
  }

  const prim = doc.createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer),
    )
    .setAttribute(
      'NORMAL',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(normals)).setBuffer(buffer),
    )
    .setAttribute(
      'JOINTS_0',
      doc.createAccessor().setType('VEC4').setArray(new Uint8Array(joints)).setBuffer(buffer),
    )
    .setAttribute(
      'WEIGHTS_0',
      doc.createAccessor().setType('VEC4').setArray(new Float32Array(weights)).setBuffer(buffer),
    )
    .setIndices(
      doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer),
    );

  // inverse bind matrices: pure translations -> IBM = T(-world)
  const ibm = new Float32Array(bones.length * 16);
  bones.forEach(([name], i) => {
    const wpos = world.get(name)!;
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -wpos[0], -wpos[1], -wpos[2], 1], i * 16);
  });
  const skin = doc.createSkin('rig')
    .setSkeleton(nodes.get('root')!)
    .setInverseBindMatrices(
      doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer),
    );
  for (const [name] of bones) skin.addJoint(nodes.get(name)!);

  const mesh = doc.createMesh('body').addPrimitive(prim);
  const meshNode = doc.createNode('body').setMesh(mesh).setSkin(skin);
  doc.createScene('scene').addChild(nodes.get('root')!).addChild(meshNode);

  return new NodeIO().writeBinary(doc);
}

for (const p of BODIES) {
  const bytes = await buildBody(p);
  const path = win(new URL(`humanoid-${p.name}.glb`, here));
  await fs.writeFile(path, bytes);
  console.log(
    `${path.split('/').at(-1)}: ${bytes.length} B, height ~${
      (p.legLen + p.torsoLen * 1.8 + p.headSize).toFixed(2)
    } m`,
  );
}
