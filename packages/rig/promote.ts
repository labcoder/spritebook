/**
 * Promoting a rig's output to the character's canonical mesh.
 *
 * Both tracks end the same way: they write a glb, and those bytes have to
 * BECOME `canonical/model.glb` or the manifest ends up describing a character
 * the files do not match. Track A learned this first (a fit left in an output
 * dir while `canonical/model.glb` still held the unfitted generated mesh made
 * every downstream verb operate on the wrong geometry); Track B had the same
 * hole for longer and it was quieter — the rigged bytes never became the
 * character at all, so `bake --clips` failed at retarget with `target skeleton
 * is missing the hips joint` immediately after a rig that reported success.
 *
 * One helper rather than two near-copies, for the reason the cache derivation
 * gave: two implementations of one rule is a hole waiting for a caller to pick
 * the wrong one, and these two had already drifted (one re-pinned a height, the
 * other did not, and only one of them should).
 *
 * The caller owns the WORDS. A refusal from a Track A fit and a refusal from a
 * Track B rig want different sentences, and a shared helper writing "the model"
 * for both would be worse copy than either.
 */
import { readWorkspace, sha256Bytes, workspacePaths } from '@spritebook/core';

export type Promotion =
  | {
    /** the bytes are now canonical/model.glb */
    promoted: true;
    /**
     * The re-pin for the SAME journaled patch as the RigState, or absent when
     * the hash did not move. Journaled apart, one undo would restore the old
     * rig while the new bytes stayed on disk.
     */
    meshRepin?: { gltfSha256: string; heightM?: number };
  }
  | {
    promoted: false;
    /** nothing has been picked yet, so there is no canonical mesh to replace */
    reason: 'no-canonical-mesh';
  }
  | {
    promoted: false;
    reason: 'io';
    error: Error;
  };

/**
 * Copy `sourcePath` over the workspace's canonical model and report what the
 * caller must journal.
 *
 * `heightM` is for a fit, which changes how tall the character stands and so
 * must re-state it. A rig adds a skeleton to the vertices it was given and does
 * not, which is why it is optional rather than a parameter both callers guess
 * at: carrying the pick's height forward is the truthful move for Track B.
 */
export async function promoteToCanonical(
  workspace: string,
  sourcePath: string,
  heightM?: number,
): Promise<Promotion> {
  try {
    const manifest = await readWorkspace(workspace);
    if (manifest.canonicalMesh === undefined) {
      return { promoted: false, reason: 'no-canonical-mesh' };
    }
    const paths = workspacePaths(workspace);
    const bytes = await Deno.readFile(sourcePath);
    await Deno.mkdir(paths.canonicalDir, { recursive: true });
    await Deno.writeFile(paths.canonicalModel, bytes);
    const gltfSha256 = await sha256Bytes(bytes);
    // an unchanged hash needs no patch — re-pinning the value already there
    // would journal a step that changes nothing
    if (gltfSha256 === manifest.canonicalMesh.gltfSha256 && heightM === undefined) {
      return { promoted: true };
    }
    return {
      promoted: true,
      meshRepin: { gltfSha256, ...(heightM === undefined ? {} : { heightM }) },
    };
  } catch (err) {
    return {
      promoted: false,
      reason: 'io',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
