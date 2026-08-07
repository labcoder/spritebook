/**
 * Remove existing skin data from a mesh so it can be rigged AGAIN.
 *
 * Both tracks promote their skinned result to `canonical/model.glb` (the
 * manifest must describe files that exist — the P3 audit), which means the
 * SECOND rig of any character receives a mesh that already has a skin. The
 * predict stage always coped (the sidecar warns and reads geometry alone);
 * `applyRig` refused — so re-rigging a character worked exactly once, and the
 * maintainer's first UX pass ended on `rig-apply-failed` the moment an
 * orientation button re-ran the rig. The refusal stays as a backstop; this
 * strip runs at the PIPELINE ENTRY so nothing downstream ever sees the old
 * skin.
 *
 * What "strip" means, precisely:
 *   - every Skin is disposed, and every JOINTS_n and WEIGHTS_n vertex
 *     attribute is detached (vertex POSITIONS are untouched — the predicted
 *     skeleton is for this same geometry, so counts must not move)
 *   - former joint NODES are removed only when their subtree carries no mesh
 *     and no animation targets them. A joint that is an ANCESTOR of a mesh
 *     node is kept as a plain transform node, because removing it would move
 *     the mesh — the old rig's placement is part of the geometry's pose now.
 *   - accessors orphaned by the above are disposed, so repeated re-rigs do
 *     not accumulate dead buffers in the canonical file
 *
 * Deliberately NOT `prune()` from @gltf-transform/functions: the
 * gltf-pipeline skill records prune/dedup breakage, and this surgery is small
 * enough to do by hand where every removal states its condition.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import type { Node } from '@gltf-transform/core';

export interface StripResult {
  /** skins removed; 0 means the mesh was already clean and nothing was written */
  skinsRemoved: number;
  jointNodesRemoved: number;
  attributesRemoved: number;
}

/** True when the node or anything under it renders geometry. */
function hasMeshInSubtree(node: Node, memo: Map<Node, boolean>): boolean {
  const hit = memo.get(node);
  if (hit !== undefined) return hit;
  const found = node.getMesh() !== null ||
    node.listChildren().some((c) => hasMeshInSubtree(c, memo));
  memo.set(node, found);
  return found;
}

export function stripSkins(doc: Document): StripResult {
  const root = doc.getRoot();
  const skins = root.listSkins();
  if (skins.length === 0) {
    return { skinsRemoved: 0, jointNodesRemoved: 0, attributesRemoved: 0 };
  }

  // collect BEFORE disposal - afterwards the skins list their joints as gone
  const jointCandidates = new Set<Node>();
  for (const skin of skins) {
    for (const j of skin.listJoints()) jointCandidates.add(j);
  }
  const animTargets = new Set<Node>();
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      const t = ch.getTargetNode();
      if (t) animTargets.add(t);
    }
  }

  let attributesRemoved = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of prim.listSemantics()) {
        if (/^(JOINTS|WEIGHTS)_\d+$/.test(semantic)) {
          prim.setAttribute(semantic, null);
          attributesRemoved++;
        }
      }
    }
  }

  for (const node of root.listNodes()) node.setSkin(null);
  for (const skin of skins) skin.dispose();

  // deepest-first, so a prunable subtree empties from the leaves up and a
  // parent's "no mesh below" verdict stays true by the time it is its turn
  const memo = new Map<Node, boolean>();
  const byDepth = [...jointCandidates].sort((a, b) => depthOf(b) - depthOf(a));
  let jointNodesRemoved = 0;
  for (const node of byDepth) {
    if (hasMeshInSubtree(node, memo)) continue;
    if (animTargets.has(node)) continue;
    if (node.listChildren().length > 0) continue; // children survived for a reason
    node.dispose();
    jointNodesRemoved++;
    memo.clear(); // parents may have just become leaves
  }

  // accessors the strip orphaned (IBMs, joint/weight arrays)
  for (const acc of root.listAccessors()) {
    if (acc.listParents().every((p) => p.propertyType === 'Root')) acc.dispose();
  }

  return { skinsRemoved: skins.length, jointNodesRemoved, attributesRemoved };
}

function depthOf(node: Node): number {
  let d = 0;
  let cur = node.getParentNode();
  while (cur) {
    d++;
    cur = cur.getParentNode();
  }
  return d;
}

/**
 * File form for the job pipeline: returns the path to rig from. Writes
 * `outPath` only when there was something to strip — a clean mesh passes
 * through untouched, path and bytes alike.
 */
export async function stripSkinsFile(
  inPath: string,
  outPath: string,
): Promise<{ path: string; result: StripResult }> {
  const io = new NodeIO();
  const doc = await io.readBinary(await Deno.readFile(inPath));
  const result = stripSkins(doc);
  if (result.skinsRemoved === 0) return { path: inPath, result };
  await Deno.writeFile(outPath, await io.writeBinary(doc));
  return { path: outPath, result };
}
