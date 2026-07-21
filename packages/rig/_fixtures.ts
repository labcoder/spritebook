/**
 * Programmatic fixtures for the rig tests (P3-T3). Nothing is checked in as
 * binary: the mesh, the skeleton and the npz are all built in memory, so the
 * tests are hermetic, GPU-free and network-free, and the npz writer here is an
 * independent implementation of the format the reader parses (a round-trip
 * against a byte-level encoder catches what a self-consistent reader cannot).
 *
 * The subject is a 4-sided tube of 9 rings standing on Y=0, rigged by a 5-joint
 * chain: three joints own one band of rings each, `bone_3` owns nothing (the
 * `no-influence` case) and `bone_4` owns only a vertex sitting exactly on its
 * own pivot (the `dead-joint` case — a joint that influences geometry yet
 * cannot move it).
 */
import { Document, NodeIO } from '@gltf-transform/core';
import type { RigSkeleton } from '@spritebook/schema';

export const LEVELS = 9;
export const RING = 4;
export const RADIUS = 0.1;
export const LEVEL_H = 0.25;
/** 36 tube vertices + the pin vertex on bone_4's head */
export const TUBE_VERTICES = LEVELS * RING;
export const PIN_VERTEX = TUBE_VERTICES;
export const VERTEX_COUNT = TUBE_VERTICES + 1;
/** bone_4's head, and the pin vertex's position */
export const PIN_POS: [number, number, number] = [0, 2.5, 0];

/** Rest positions in the same order the glb stores them. */
export function tubePositions(): Float32Array<ArrayBuffer> {
  const p = new Float32Array(VERTEX_COUNT * 3);
  for (let l = 0; l < LEVELS; l++) {
    for (let r = 0; r < RING; r++) {
      const a = (r / RING) * Math.PI * 2;
      const i = (l * RING + r) * 3;
      p[i] = Math.cos(a) * RADIUS;
      p[i + 1] = l * LEVEL_H;
      p[i + 2] = Math.sin(a) * RADIUS;
    }
  }
  p.set(PIN_POS, PIN_VERTEX * 3);
  return p;
}

/** The unrigged canonical mesh: one mesh, one primitive, POSITION + NORMAL. */
export async function buildTubeGlb(): Promise<Uint8Array> {
  const positions = tubePositions();
  const normals = new Float32Array(VERTEX_COUNT * 3);
  for (let v = 0; v < VERTEX_COUNT; v++) {
    const x = positions[v * 3], z = positions[v * 3 + 2];
    const len = Math.hypot(x, z) || 1;
    normals[v * 3] = x / len;
    normals[v * 3 + 2] = z / len;
  }
  const indices: number[] = [];
  for (let l = 0; l + 1 < LEVELS; l++) {
    for (let r = 0; r < RING; r++) {
      const a = l * RING + r;
      const b = l * RING + ((r + 1) % RING);
      const c = a + RING;
      const d = b + RING;
      indices.push(a, b, d, a, d, c);
    }
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer),
    )
    .setAttribute(
      'NORMAL',
      doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer),
    )
    .setIndices(
      doc.createAccessor().setType('SCALAR').setArray(Uint16Array.from(indices)).setBuffer(buffer),
    );
  const mesh = doc.createMesh('tube').addPrimitive(prim);
  doc.createScene('scene').addChild(doc.createNode('tube').setMesh(mesh));
  return await new NodeIO().writeBinary(doc);
}

/** The 5-joint chain: three working bands, one empty joint, one pinned joint. */
export function chainSkeleton(patch: Partial<RigSkeleton> = {}): RigSkeleton {
  return {
    schemaVersion: 1,
    backend: { modelId: 'fixture', version: '0.0.0' },
    seed: 7,
    joints: [
      { name: 'bone_0', parent: -1, head: [0, 0, 0], tail: [0, 0.75, 0] },
      { name: 'bone_1', parent: 0, head: [0, 0.75, 0], tail: [0, 1.5, 0] },
      { name: 'bone_2', parent: 1, head: [0, 1.5, 0], tail: [0, 2, 0] },
      { name: 'bone_3', parent: 2, head: [0, 2, 0], tail: [0, 2.5, 0] },
      { name: 'bone_4', parent: 3, head: PIN_POS, tail: [0, 3, 0] },
    ],
    semanticNames: false,
    vertexCount: VERTEX_COUNT,
    influencesPerVertex: 4,
    validation: {
      nonFiniteWeights: 0,
      unnormalizedVertices: 0,
      zeroWeightVertices: 0,
      retries: 0,
    },
    ...patch,
  };
}

/** Which band a tube vertex belongs to: rings 0-2 / 3-5 / 6-8. */
export function bandOf(vertex: number): number {
  return Math.min(2, Math.floor(Math.floor(vertex / RING) / 3));
}

export interface WeightArrays {
  joints: Uint32Array;
  weights: Float32Array;
}

/**
 * Rigid band weights: every tube vertex fully on its band's joint, the pin
 * vertex fully on `bone_4`. `bone_3` deliberately owns nothing.
 */
export function cleanWeights(): WeightArrays {
  const joints = new Uint32Array(VERTEX_COUNT * 4);
  const weights = new Float32Array(VERTEX_COUNT * 4);
  for (let v = 0; v < TUBE_VERTICES; v++) {
    joints[v * 4] = bandOf(v);
    weights[v * 4] = 1;
  }
  joints[PIN_VERTEX * 4] = 4;
  weights[PIN_VERTEX * 4] = 1;
  return { joints, weights };
}

/**
 * The shredding fixture: one vertex of `bone_1`'s band is left with a sliver of
 * weight on `bone_1` and the rest on the distant, unmoving `bone_0`. It stays
 * inside `bone_1`'s influenced set (its weight clears the floor) while barely
 * following it, so the edges to its rigid ring neighbours tear open — the
 * numeric signature of P0-T4 catalog item 1.
 */
export const SHREDDED_VERTEX = 5 * RING; // first vertex of ring 5, bone_1's band

export function shreddedWeights(): WeightArrays {
  const w = cleanWeights();
  w.joints[SHREDDED_VERTEX * 4] = 1;
  w.weights[SHREDDED_VERTEX * 4] = 0.06;
  w.joints[SHREDDED_VERTEX * 4 + 1] = 0;
  w.weights[SHREDDED_VERTEX * 4 + 1] = 0.94;
  return w;
}

// ---------------------------------------------------------------------------
// npy / npz encoding (independent of packages/rig/npz.ts on purpose)
// ---------------------------------------------------------------------------

export type FixtureDType = 'uint8' | 'uint16' | 'uint32' | 'int32' | 'float32';

const DESCR: Record<FixtureDType, string> = {
  uint8: '|u1',
  uint16: '<u2',
  uint32: '<u4',
  int32: '<i4',
  float32: '<f4',
};

const ITEM_SIZE: Record<FixtureDType, number> = {
  uint8: 1,
  uint16: 2,
  uint32: 4,
  int32: 4,
  float32: 4,
};

export interface NpyOptions {
  /** npy format major version (1 = u16 header length, 2 = u32) */
  version?: 1 | 2;
  fortranOrder?: boolean;
  /** override the dtype string, to build files this repo refuses to read */
  descr?: string;
}

/** Encode one array exactly as `numpy.save` would, padding included. */
export function encodeNpy(
  dtype: FixtureDType,
  shape: number[],
  data: ArrayLike<number>,
  opts: NpyOptions = {},
): Uint8Array {
  const version = opts.version ?? 1;
  const descr = opts.descr ?? DESCR[dtype];
  const shapeSrc = shape.length === 1 ? `${shape[0]},` : shape.join(', ');
  let header = `{'descr': '${descr}', 'fortran_order': ${
    opts.fortranOrder ? 'True' : 'False'
  }, 'shape': (${shapeSrc}), }`;
  const prefix = version === 1 ? 10 : 12;
  const pad = (64 - ((prefix + header.length + 1) % 64)) % 64;
  header = `${header}${' '.repeat(pad)}\n`;
  const headerBytes = new TextEncoder().encode(header);

  const size = ITEM_SIZE[dtype];
  const out = new Uint8Array(prefix + headerBytes.length + data.length * size);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, version, 0]);
  const view = new DataView(out.buffer);
  if (version === 1) view.setUint16(8, headerBytes.length, true);
  else view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, prefix);

  let o = prefix + headerBytes.length;
  for (let i = 0; i < data.length; i++, o += size) {
    switch (dtype) {
      case 'uint8':
        view.setUint8(o, data[i]);
        break;
      case 'uint16':
        view.setUint16(o, data[i], true);
        break;
      case 'uint32':
        view.setUint32(o, data[i], true);
        break;
      case 'int32':
        view.setInt32(o, data[i], true);
        break;
      case 'float32':
        view.setFloat32(o, data[i], true);
        break;
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipMember {
  name: string;
  data: Uint8Array;
  /** store (false, what np.savez writes) or deflate (true, np.savez_compressed) */
  deflate?: boolean;
}

/** A real ZIP archive, written by hand so the reader is tested against bytes. */
export async function encodeZip(members: ZipMember[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();

  for (const m of members) {
    const name = encoder.encode(m.name);
    const stored = m.deflate ? await deflateRaw(m.data) : m.data;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, m.deflate ? 8 : 0, true);
    lv.setUint32(14, crc32(m.data), true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, m.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, stored);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, m.deflate ? 8 : 0, true);
    cv.setUint32(16, crc32(m.data), true);
    cv.setUint32(20, stored.length, true);
    cv.setUint32(24, m.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + stored.length;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, members.length, true);
  ev.setUint16(10, members.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of all) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export interface NpzArraySpec {
  name: string;
  dtype: FixtureDType;
  shape: number[];
  data: ArrayLike<number>;
  npy?: NpyOptions;
  deflate?: boolean;
}

/** `np.savez`-shaped archive: one `<name>.npy` member per array. */
export async function encodeNpz(specs: NpzArraySpec[]): Promise<Uint8Array> {
  return await encodeZip(specs.map((s) => ({
    name: `${s.name}.npy`,
    data: encodeNpy(s.dtype, s.shape, s.data, s.npy),
    deflate: s.deflate,
  })));
}

/** The fixture's weights as an npz, with `joints` as uint16 like a real adapter. */
export async function weightsNpz(
  w: WeightArrays,
  influences = 4,
  vertexCount = VERTEX_COUNT,
): Promise<Uint8Array> {
  return await encodeNpz([
    { name: 'joints', dtype: 'uint16', shape: [vertexCount, influences], data: w.joints },
    { name: 'weights', dtype: 'float32', shape: [vertexCount, influences], data: w.weights },
  ]);
}

// ---------------------------------------------------------------------------
// Scratch directory
// ---------------------------------------------------------------------------

export interface RigCase {
  dir: string;
  meshPath: string;
  skeletonPath: string;
  weightsPath: string;
  outPath: string;
}

/** Write mesh + rig.json + rig.npz into a fresh temp dir. */
export async function stageCase(
  skeleton: RigSkeleton = chainSkeleton(),
  weightsBytes?: Uint8Array,
  glbBytes?: Uint8Array,
): Promise<RigCase> {
  const weights = weightsBytes ?? await weightsNpz(cleanWeights());
  const glb = glbBytes ?? await buildTubeGlb();
  const dir = await Deno.makeTempDir({ prefix: 'spritebook-rig-' });
  const c: RigCase = {
    dir,
    meshPath: `${dir}/mesh.glb`,
    skeletonPath: `${dir}/rig.json`,
    weightsPath: `${dir}/rig.npz`,
    outPath: `${dir}/rigged.glb`,
  };
  await Deno.writeFile(c.meshPath, glb);
  await Deno.writeTextFile(c.skeletonPath, JSON.stringify(skeleton));
  await Deno.writeFile(c.weightsPath, weights);
  return c;
}
