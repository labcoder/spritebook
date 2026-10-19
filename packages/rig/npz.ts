import { promises as fs } from 'node:fs';
/**
 * A minimal NPZ/NPY reader (P3-T3). The rig adapter returns per-vertex arrays
 * as `rig.npz` (schema/rig.ts) because they are large and numeric, and core
 * reads them by path across the D-004 seam.
 *
 * ## Why hand-rolled
 *
 * An npz is a plain ZIP of `.npy` members and an npy is a 6-byte magic, a
 * one-line Python dict header, and raw C-order bytes. The whole format that
 * matters here is under 200 lines, and a dependency for it would be a supply
 * chain (and a licence row) bought for a header parser. `docs/dependencies.md`
 * asks the question before every new dep; this is the answer.
 *
 * ## What is supported, and what fails loud
 *
 * - Members stored (method 0) or deflated (method 8, via `DecompressionStream`
 *   — `np.savez` writes the former, `np.savez_compressed` the latter).
 * - dtypes `uint8`, `uint16`, `uint32`, `int32`, `float32`, little-endian, C
 *   order. Anything else — big-endian, float64, Fortran order, object arrays —
 *   throws naming the dtype it found, because silently reinterpreting the bytes
 *   of a 4.4 GB skin-weight matrix is exactly the class of failure P0-T4 spent
 *   a week on (all-NaN weights, exit code 0).
 * - Sizes come from the CENTRAL directory, never the local header: `np.savez`
 *   opens members in streaming mode, so local headers carry zeroes and a
 *   trailing data descriptor. The local header is used only to find where the
 *   data starts.
 */

/** The dtypes this reader accepts; everything else is an actionable throw. */
export type NpyDType = 'uint8' | 'uint16' | 'uint32' | 'int32' | 'float32';

export type NpyData = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array;

export interface NpyArray {
  dtype: NpyDType;
  /** dimensions, outermost first (C order) */
  shape: number[];
  data: NpyData;
}

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

const DTYPES: Record<string, { dtype: NpyDType; size: number }> = {
  u1: { dtype: 'uint8', size: 1 },
  b1: { dtype: 'uint8', size: 1 },
  u2: { dtype: 'uint16', size: 2 },
  u4: { dtype: 'uint32', size: 4 },
  i4: { dtype: 'int32', size: 4 },
  f4: { dtype: 'float32', size: 4 },
};

const SUPPORTED = 'uint8, uint16, uint32, int32, float32 (little-endian, C order)';

/** True when the array's element type can index a joint. */
export function isIntegerDType(d: NpyDType): boolean {
  return d !== 'float32';
}

// ---------------------------------------------------------------------------
// npy
// ---------------------------------------------------------------------------

/**
 * Parse one `.npy` member. `label` names the member in every error message —
 * "readNpz: rig.npz[weights]: ..." beats a stack trace inside a byte reader.
 */
export function parseNpy(bytes: Uint8Array, label: string): NpyArray {
  if (bytes.length < 10) throw new Error(`${label}: truncated npy (${bytes.length} bytes)`);
  for (let i = 0; i < NPY_MAGIC.length; i++) {
    if (bytes[i] !== NPY_MAGIC[i]) throw new Error(`${label}: not an npy file (bad magic)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  let headerLen: number;
  let headerStart: number;
  if (major === 1) {
    headerLen = view.getUint16(8, true);
    headerStart = 10;
  } else if (major === 2 || major === 3) {
    headerLen = view.getUint32(8, true);
    headerStart = 12;
  } else {
    throw new Error(`${label}: unsupported npy format version ${major}.${bytes[7]}`);
  }
  const dataStart = headerStart + headerLen;
  if (dataStart > bytes.length) throw new Error(`${label}: npy header runs past end of file`);
  const header = new TextDecoder().decode(bytes.subarray(headerStart, dataStart));

  const descr = /'descr'\s*:\s*'([^']*)'/.exec(header)?.[1];
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header)?.[1];
  const shapeSrc = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (descr === undefined || fortran === undefined || shapeSrc === undefined) {
    throw new Error(`${label}: unreadable npy header ${JSON.stringify(header.trim())}`);
  }
  if (fortran === 'True') {
    throw new Error(`${label}: Fortran-order array — save it C-order (np.ascontiguousarray)`);
  }
  if (descr.startsWith('>')) {
    throw new Error(`${label}: big-endian dtype '${descr}' — supported: ${SUPPORTED}`);
  }
  const kind = DTYPES[descr.replace(/^[<>|=]/, '')];
  if (!kind) throw new Error(`${label}: unsupported dtype '${descr}' — supported: ${SUPPORTED}`);

  const shape = shapeSrc.trim() === ''
    ? []
    : shapeSrc.split(',').map((s) => s.trim()).filter((s) => s !== '').map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${label}: bad shape entry '${s}'`);
      return n;
    });

  const count = shape.reduce((a, b) => a * b, 1);
  const need = count * kind.size;
  const have = bytes.length - dataStart;
  if (have < need) {
    throw new Error(
      `${label}: truncated data — shape ${JSON.stringify(shape)} of ${kind.dtype} needs ` +
        `${need} bytes, file has ${have}`,
    );
  }

  // Copy through a DataView: the member's data offset inside the zip has no
  // alignment guarantee, so a typed-array view over the same buffer would throw
  // on some offsets and silently mis-read on none — copying is the only correct
  // option and costs one pass.
  const data = allocate(kind.dtype, count);
  const src = new DataView(bytes.buffer, bytes.byteOffset + dataStart, need);
  for (let i = 0; i < count; i++) {
    switch (kind.dtype) {
      case 'uint8':
        data[i] = src.getUint8(i);
        break;
      case 'uint16':
        data[i] = src.getUint16(i * 2, true);
        break;
      case 'uint32':
        data[i] = src.getUint32(i * 4, true);
        break;
      case 'int32':
        data[i] = src.getInt32(i * 4, true);
        break;
      case 'float32':
        data[i] = src.getFloat32(i * 4, true);
        break;
    }
  }
  return { dtype: kind.dtype, shape, data };
}

function allocate(dtype: NpyDType, count: number): NpyData {
  switch (dtype) {
    case 'uint8':
      return new Uint8Array(count);
    case 'uint16':
      return new Uint16Array(count);
    case 'uint32':
      return new Uint32Array(count);
    case 'int32':
      return new Int32Array(count);
    case 'float32':
      return new Float32Array(count);
  }
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const U32_MAX = 0xffffffff;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function findEocd(view: DataView, label: string): number {
  // the EOCD is at the end, behind a comment of up to 64 KiB
  const from = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= from; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error(`${label}: not a zip archive (no end-of-central-directory record)`);
}

/**
 * Zip64 extra field (header id 0x0001) in a central-directory entry: the 8-byte
 * replacements appear IN ORDER, and only for the fields whose 32-bit slot is
 * saturated. `np.savez` passes force_zip64, so this path is reachable for large
 * weight matrices, not just theoretically.
 */
function readZip64Extra(view: DataView, start: number, len: number, e: ZipEntry): void {
  let p = start;
  const end = start + len;
  while (p + 4 <= end) {
    const id = view.getUint16(p, true);
    const size = view.getUint16(p + 2, true);
    let q = p + 4;
    if (id === 0x0001) {
      if (e.uncompressedSize === U32_MAX && q + 8 <= end) {
        e.uncompressedSize = Number(view.getBigUint64(q, true));
        q += 8;
      }
      if (e.compressedSize === U32_MAX && q + 8 <= end) {
        e.compressedSize = Number(view.getBigUint64(q, true));
        q += 8;
      }
      if (e.localOffset === U32_MAX && q + 8 <= end) {
        e.localOffset = Number(view.getBigUint64(q, true));
      }
      return;
    }
    p += 4 + size;
  }
}

function listEntries(bytes: Uint8Array, label: string): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, label);
  const count = view.getUint16(eocd + 10, true);
  let cd = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cd === U32_MAX) {
    throw new Error(`${label}: zip64 central directory is not supported`);
  }
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(cd, true) !== CD_SIG) {
      throw new Error(`${label}: corrupt central directory at entry ${i}`);
    }
    const nameLen = view.getUint16(cd + 28, true);
    const extraLen = view.getUint16(cd + 30, true);
    const commentLen = view.getUint16(cd + 32, true);
    const entry: ZipEntry = {
      name: decoder.decode(bytes.subarray(cd + 46, cd + 46 + nameLen)),
      method: view.getUint16(cd + 10, true),
      compressedSize: view.getUint32(cd + 20, true),
      uncompressedSize: view.getUint32(cd + 24, true),
      localOffset: view.getUint32(cd + 42, true),
    };
    readZip64Extra(view, cd + 46 + nameLen, extraLen, entry);
    entries.push(entry);
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(bytes: Uint8Array, label: string): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    throw new Error(`${label}: deflate stream is corrupt (${(err as Error).message})`);
  }
}

async function memberBytes(bytes: Uint8Array, e: ZipEntry, label: string): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (e.localOffset + 30 > bytes.length || view.getUint32(e.localOffset, true) !== LOCAL_SIG) {
    throw new Error(`${label}: member "${e.name}" has no local file header`);
  }
  // local sizes are unreliable (streamed members write zeroes + a data
  // descriptor); the header is only good for locating the data
  const nameLen = view.getUint16(e.localOffset + 26, true);
  const extraLen = view.getUint16(e.localOffset + 28, true);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const end = start + e.compressedSize;
  if (end > bytes.length) throw new Error(`${label}: member "${e.name}" runs past end of archive`);
  const raw = bytes.subarray(start, end);
  if (e.method === 0) return raw;
  if (e.method === 8) return await inflateRaw(raw, `${label}[${e.name}]`);
  throw new Error(`${label}: member "${e.name}" uses zip compression method ${e.method}`);
}

// ---------------------------------------------------------------------------
// npz
// ---------------------------------------------------------------------------

/**
 * Read every array in an npz. Keys are member names with the `.npy` suffix
 * stripped, which is how `np.savez(path, joints=..., weights=...)` names them.
 */
export async function readNpz(bytes: Uint8Array, label: string): Promise<Map<string, NpyArray>> {
  const out = new Map<string, NpyArray>();
  for (const entry of listEntries(bytes, label)) {
    if (entry.name.endsWith('/')) continue; // directory member
    const key = entry.name.replace(/\.npy$/i, '');
    const data = await memberBytes(bytes, entry, label);
    out.set(key, parseNpy(data, `${label}[${key}]`));
  }
  return out;
}

/** readNpz over a file path; the path is the label, so errors point at it. */
export async function readNpzFile(path: string): Promise<Map<string, NpyArray>> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(path));
  } catch (err) {
    throw new Error(`readNpz: cannot read "${path}" (${(err as Error).message})`);
  }
  return await readNpz(bytes, `readNpz: ${path}`);
}
