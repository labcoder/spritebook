import { readWorkspace, sha256Bytes } from '@spritebook/core';

type Promotion =
  | { ready: true; canonicalSource: string; meshRepin?: { gltfSha256: string; heightM?: number } }
  | { ready: false; reason: 'no-canonical-mesh' }
  | { ready: false; reason: 'io'; error: Error };

/** Prepare the rig's re-pin; setRigState publishes its bytes and metadata together. */
export async function prepareCanonicalPromotion(
  workspace: string,
  sourcePath: string,
  heightM?: number,
): Promise<Promotion> {
  try {
    const manifest = await readWorkspace(workspace);
    if (!manifest.canonicalMesh) return { ready: false, reason: 'no-canonical-mesh' };
    const gltfSha256 = await sha256Bytes(await Deno.readFile(sourcePath));
    return {
      ready: true,
      canonicalSource: sourcePath,
      ...(gltfSha256 === manifest.canonicalMesh.gltfSha256 &&
          (heightM === undefined || heightM === manifest.canonicalMesh.heightM)
        ? {}
        : {
          meshRepin: { gltfSha256, ...(heightM === undefined ? {} : { heightM }) },
        }),
    };
  } catch (err) {
    return {
      ready: false,
      reason: 'io',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
