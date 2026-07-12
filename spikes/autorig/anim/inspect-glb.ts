// P0-T4: inspect animation .glb files — clip inventory, durations, joint naming,
// and whether a skinned mesh (vs armature/joints only) is present.
//
// Usage: deno run --allow-read inspect-glb.ts <file.glb> [more.glb ...]
//
// Pattern follows spikes/webgpu/asset.ts (WebIO from @gltf-transform/core, pinned 4.2.1).

import { WebIO, type Node } from 'npm:@gltf-transform/core@4.2.1';

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

async function inspect(path: string): Promise<void> {
  const doc = await new WebIO().readBinary(await Deno.readFile(path));
  const root = doc.getRoot();

  console.log(`\n=== ${path} ===`);
  const asset = root.getAsset();
  console.log(`generator: ${asset.generator ?? '(none)'} | glTF ${asset.version}`);

  // --- scenes / nodes overview -------------------------------------------
  const scenes = root.listScenes();
  const meshes = root.listMeshes();
  const skins = root.listSkins();
  const anims = root.listAnimations();
  console.log(
    `scenes=${scenes.length} nodes=${root.listNodes().length} meshes=${meshes.length} ` +
      `skins=${skins.length} animations=${anims.length} materials=${root.listMaterials().length}`,
  );

  // --- skinned mesh vs armature-only -------------------------------------
  const skinnedMeshNodes = root.listNodes().filter((n) => n.getMesh() && n.getSkin());
  if (skinnedMeshNodes.length > 0) {
    console.log(`skinned mesh: YES (${skinnedMeshNodes.length} node(s) with mesh+skin)`);
    for (const n of skinnedMeshNodes) {
      const mesh = n.getMesh()!;
      const prims = mesh.listPrimitives();
      const verts = prims[0]?.getAttribute('POSITION')?.getCount() ?? 0;
      console.log(
        `  node "${n.getName()}" mesh "${mesh.getName()}" prims=${prims.length} verts(prim0)=${verts} ` +
          `joints=${n.getSkin()!.listJoints().length}`,
      );
    }
  } else if (meshes.length > 0) {
    console.log(`skinned mesh: NO — ${meshes.length} unskinned mesh(es) present`);
  } else {
    console.log('skinned mesh: NO — armature/joints only');
  }

  // --- joint naming convention --------------------------------------------
  for (const [si, skin] of skins.entries()) {
    const joints = skin.listJoints();
    const names = joints.map((j) => j.getName());
    console.log(`skin[${si}] "${skin.getName()}" — ${joints.length} joints`);
    console.log(`  first 12: ${names.slice(0, 12).join(', ')}`);
    const prefixed = names.filter((n) => n.includes(':'));
    console.log(
      prefixed.length > 0
        ? `  prefix convention: ${prefixed.length}/${names.length} contain ':' e.g. "${prefixed[0]}"`
        : '  prefix convention: none (bare bone names)',
    );
    const mixamo = names.filter((n) => n.toLowerCase().includes('mixamorig'));
    if (mixamo.length > 0) console.log(`  mixamorig-style names: ${mixamo.length}`);
    // roots of the joint hierarchy (parent not itself a joint of this skin)
    const jointSet = new Set<Node>(joints);
    const parentOf = new Map<Node, Node>();
    const walk = (n: Node) => {
      for (const c of n.listChildren()) {
        parentOf.set(c, n);
        walk(c);
      }
    };
    for (const scene of scenes) for (const n of scene.listChildren()) walk(n);
    const jointRoots = joints.filter((j) => !jointSet.has(parentOf.get(j)!));
    console.log(
      `  hierarchy roots: ${jointRoots.map((r) => `"${r.getName()}" (parent: ${parentOf.get(r)?.getName() ?? 'scene'})`).join(', ')}`,
    );
  }

  // If no skins, joints may still exist as plain node hierarchies (armature-only files).
  if (skins.length === 0) {
    const animated = new Set<string>();
    for (const a of anims) {
      for (const ch of a.listChannels()) {
        const t = ch.getTargetNode();
        if (t) animated.add(t.getName());
      }
    }
    console.log(`  (no skins) animated node names, first 12: ${[...animated].slice(0, 12).join(', ')}`);
  }

  // --- animation clips ------------------------------------------------------
  console.log(`animation clips (${anims.length}):`);
  for (const a of anims) {
    let maxT = 0;
    let minT = Infinity;
    const paths = new Set<string>();
    const targets = new Set<string>();
    for (const ch of a.listChannels()) {
      paths.add(ch.getTargetPath() ?? '?');
      const t = ch.getTargetNode();
      if (t) targets.add(t.getName());
      const input = ch.getSampler()?.getInput();
      const arr = input?.getArray();
      if (arr && arr.length > 0) {
        maxT = Math.max(maxT, arr[arr.length - 1] as number);
        minT = Math.min(minT, arr[0] as number);
      }
    }
    if (!Number.isFinite(minT)) minT = 0;
    console.log(
      `  "${a.getName()}" — ${fmt(maxT - minT)}s (t=${fmt(minT)}..${fmt(maxT)}) ` +
        `channels=${a.listChannels().length} targets=${targets.size} paths=[${[...paths].join(',')}]`,
    );
  }
}

if (import.meta.main) {
  if (Deno.args.length === 0) {
    console.error('usage: deno run --allow-read inspect-glb.ts <file.glb> [...]');
    Deno.exit(1);
  }
  for (const p of Deno.args) await inspect(p);
}
