/**
 * The symptom the promotion actually fixes, before and after.
 *
 * `rig --workspace` used to journal a RigState and leave `canonical/model.glb`
 * unskinned, so the very next `bake --clips` died inside the retarget with
 * `target skeleton is missing the hips joint "pelvis"` — immediately after a
 * rig that reported success. (UAL's hips joint is named `pelvis`; the message
 * interpolates the profile's name.) That failure is loud and correct on its own
 * terms; what made it a defect is that the manifest said the character was
 * rigged.
 *
 * This asserts the claim the promotion commit makes, rather than trusting it:
 * the same workspace goes from throwing to retargeting cleanly, with promotion
 * the only thing that changed. CPU-only — the retarget is where the skeleton is
 * consulted, so no GPU is needed to prove it.
 */
import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { Document, NodeIO } from '@gltf-transform/core';
import {
  appendGenerationResult,
  createWorkspace,
  pickResult,
  setCanonicalMesh,
  sha256Bytes,
  workspacePaths,
} from '@spritebook/core';
import {
  loadPackClip,
  loadSkeletonRestFromFile,
  retargetClip,
  UAL_HUMANOID,
} from '@spritebook/anim';
import { prepareCanonicalPromotion } from './promote.ts';

const NOW = () => '2026-07-12T00:00:00Z';
const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
/** a real UAL-compatible skinned humanoid — what a rig produces */
const RIGGED = win(new URL('../anim/fixtures/humanoid-normal.glb', import.meta.url));
const PACK = win(new URL('../anim/packs/ual', import.meta.url));

/** what `gen` + `pick` leave behind: geometry, no skeleton at all. */
async function unskinnedGlb(path: string): Promise<void> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const pos = doc.createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buf);
  const mesh = doc.createMesh('body').addPrimitive(
    doc.createPrimitive().setAttribute('POSITION', pos),
  );
  doc.createScene().addChild(doc.createNode('bodyNode').setMesh(mesh));
  await Deno.writeFile(path, await new NodeIO().writeBinary(doc));
}

Deno.test('promotion is what lets the very next clip bake retarget at all', async () => {
  const raw = await Deno.makeTempDir({ prefix: 'sb-promoted-bake-' });
  const dir = raw.replaceAll('\\', '/');
  try {
    await createWorkspace({
      workspace: dir,
      characterId: 'brave-knight',
      displayName: 'Brave Knight',
      source: { kind: 'image', originalFilename: 'k.png', sha256: 'a'.repeat(64) },
      now: NOW,
    });
    await unskinnedGlb(workspacePaths(dir).canonicalModel);
    await appendGenerationResult(dir, {
      id: 'r1',
      backend: { modelId: 'fixture-gen', version: '1.0' },
      params: {},
      seed: 7,
      startedAt: NOW(),
      wallTimeS: 1,
      output: {
        gltfSha256: await sha256Bytes(await Deno.readFile(workspacePaths(dir).canonicalModel)),
        tris: 1,
        kind: 'mesh',
      },
      discarded: false,
    }, { now: NOW });
    await pickResult(dir, 'r1', { heightM: 1.8, texturedBy: 'backend', now: NOW });

    const canonical = workspacePaths(dir).canonicalModel;
    await unskinnedGlb(canonical);

    const clip = await loadPackClip(PACK, 'walk-loop');
    const sourceRest = await loadSkeletonRestFromFile(`${PACK}/clips/walk-loop.glb`);

    // BEFORE: the manifest can claim a rig all it likes; the bytes have none
    const before = await loadSkeletonRestFromFile(canonical);
    assertEquals(before.locals.size, 0, 'an unskinned mesh has no joints to drive');
    const err = assertThrows(
      () => retargetClip(clip, sourceRest, before, UAL_HUMANOID),
      Error,
    );
    assert(
      err.message.includes('target skeleton is missing the hips joint'),
      `the exact symptom: ${err.message}`,
    );

    // the rig's output becomes the character — the one thing that changes
    const promotion = await prepareCanonicalPromotion(dir, RIGGED);
    assert(promotion.ready && promotion.meshRepin, 'prepared');
    await setCanonicalMesh(dir, promotion.meshRepin, {
      canonicalSource: promotion.canonicalSource,
    });

    // AFTER: the same call, on the same workspace, retargets
    const after = await loadSkeletonRestFromFile(canonical);
    assert(after.locals.size > 0, 'the canonical mesh carries a skeleton now');
    const { report } = retargetClip(clip, sourceRest, after, UAL_HUMANOID);
    // the profile's own name for the hips, not a literal: UAL calls it
    // `pelvis`, and hardcoding "hips" made this assertion fail against a
    // retarget that had in fact worked
    assert(
      report.mapped.includes(UAL_HUMANOID.hips),
      `the hips joint drives, so root motion transfers: ${report.mapped.join(', ')}`,
    );
    assertEquals(report.unmappedTarget, [], 'every joint of the rigged body is driven');
    assertEquals(report.mapped.length, UAL_HUMANOID.core.length, 'all 21 core joints');
  } finally {
    await Deno.remove(raw, { recursive: true });
  }
});
