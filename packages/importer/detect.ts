/**
 * Source-format detection. Extension picks the reader; for glTF-family files
 * the JSON is peeked BEFORE parsing to detect VRM and its version — VRM 0.x
 * characters face -Z and must be rotated to +Z at the border (skill: detect
 * the version before orienting; VRM 1.0 already faces +Z).
 */
import { ImportError } from './errors.ts';

export type SourceFormat = 'glb' | 'gltf' | 'obj' | 'fbx';
export type VrmVersion = 'vrm0' | 'vrm1' | 'none';

export interface DetectedSource {
  format: SourceFormat;
  vrm: VrmVersion;
}

export function formatFromPath(path: string): SourceFormat {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'glb':
    case 'vrm': // VRM containers are glb
      return 'glb';
    case 'gltf':
      return 'gltf';
    case 'obj':
      return 'obj';
    case 'fbx':
      return 'fbx';
    default:
      throw new ImportError(
        `Unsupported source format ".${ext}" (${path}) - supported: glb, gltf, vrm, obj, fbx`,
      );
  }
}

/** Extract the JSON chunk of a .glb, or parse .gltf text. */
function gltfJson(
  bytes: Uint8Array,
  format: 'glb' | 'gltf',
  path: string,
): Record<string, unknown> {
  try {
    if (format === 'gltf') {
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) {
      throw new Error('missing glTF magic');
    }
    const jsonLength = view.getUint32(12, true);
    const jsonType = view.getUint32(16, true);
    if (jsonType !== 0x4e4f534a) throw new Error('first chunk is not JSON');
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  } catch (err) {
    throw new ImportError(
      `${path}: not a valid ${format} file (${err instanceof Error ? err.message : err})`,
    );
  }
}

export function detectVrm(bytes: Uint8Array, format: SourceFormat, path: string): VrmVersion {
  if (format !== 'glb' && format !== 'gltf') return 'none';
  const json = gltfJson(bytes, format, path);
  const used = Array.isArray(json.extensionsUsed) ? (json.extensionsUsed as string[]) : [];
  if (used.includes('VRMC_vrm')) return 'vrm1';
  if (used.includes('VRM')) return 'vrm0';
  return 'none';
}
