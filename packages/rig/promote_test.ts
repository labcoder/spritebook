/**
 * Promotion is what makes a rig reach the character. Track A had it; Track B
 * did not, so `rig --workspace` left the manifest describing a skeleton that
 * `canonical/model.glb` did not have — and the first thing to notice was
 * `bake --clips` failing at retarget with "target skeleton is missing the hips
 * joint" immediately after a rig that reported success.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  appendGenerationResult,
  createWorkspace,
  pickResult,
  readWorkspace,
  setCanonicalMesh,
  sha256Bytes,
  workspacePaths,
} from '@spritebook/core';
import { promoteToCanonical } from './promote.ts';

const NOW = () => '2026-07-12T00:00:00Z';
const sha = (c: string) => c.repeat(64);

async function withCharacter(
  fn: (dir: string) => Promise<void>,
  opts: { picked?: boolean } = {},
): Promise<void> {
  const raw = await Deno.makeTempDir({ prefix: 'sb-promote-' });
  const dir = raw.replaceAll('\\', '/');
  try {
    await createWorkspace({
      workspace: dir,
      characterId: 'brave-knight',
      displayName: 'Brave Knight',
      source: { kind: 'image', originalFilename: 'k.png', sha256: sha('a') },
      now: NOW,
    });
    if (opts.picked !== false) {
      await appendGenerationResult(dir, {
        id: 'r1',
        backend: { modelId: 'fixture-gen', version: '1.0' },
        params: {},
        seed: 7,
        startedAt: NOW(),
        wallTimeS: 1,
        output: { gltfSha256: sha('b'), tris: 12, kind: 'mesh' },
        discarded: false,
      }, { now: NOW });
      await pickResult(dir, 'r1', { heightM: 1.8, texturedBy: 'backend', now: NOW });
    }
    await fn(dir);
  } finally {
    await Deno.remove(raw, { recursive: true });
  }
}

Deno.test('the rigged bytes become the canonical mesh, and the hash follows', async () => {
  await withCharacter(async (dir) => {
    const rigged = `${dir}/rigged.glb`;
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    await Deno.writeFile(rigged, bytes);

    const result = await promoteToCanonical(dir, rigged);
    assert(result.promoted, 'promoted');
    assertEquals(result.meshRepin?.gltfSha256, await sha256Bytes(bytes));
    assertEquals(result.meshRepin?.heightM, undefined, 'a rig does not restate height');

    // the bytes really moved, not just the bookkeeping
    assertEquals(await Deno.readFile(workspacePaths(dir).canonicalModel), bytes);
  });
});

Deno.test('a fit restates its height; a rig deliberately does not', async () => {
  // rigging adds a skeleton to the vertices it was given and does not change
  // how tall the character stands, so carrying the pick's height forward is the
  // truthful move - inventing one would be provenance fiction
  await withCharacter(async (dir) => {
    const src = `${dir}/fitted.glb`;
    await Deno.writeFile(src, Uint8Array.from([9, 9, 9]));
    const fit = await promoteToCanonical(dir, src, 1.74);
    assert(fit.promoted);
    assertEquals(fit.meshRepin?.heightM, 1.74);
  });
});

Deno.test('unchanged bytes need no patch', async () => {
  // re-pinning the hash already recorded would journal a step that changes
  // nothing, and an undo stack with empty steps is one a user stops trusting.
  // The helper REPORTS the re-pin and the caller journals it, so the second
  // run only sees "unchanged" once the first one's has been recorded — which
  // is exactly the sequence `rig` runs twice on the same character.
  await withCharacter(async (dir) => {
    const bytes = Uint8Array.from([7, 7, 7]);
    const src = `${dir}/rigged.glb`;
    await Deno.writeFile(src, bytes);

    const first = await promoteToCanonical(dir, src);
    assert(first.promoted && first.meshRepin, 'the first rig moves the hash');
    await setCanonicalMesh(dir, first.meshRepin, { now: NOW });
    assertEquals((await readWorkspace(dir)).canonicalMesh?.gltfSha256, await sha256Bytes(bytes));

    const again = await promoteToCanonical(dir, src);
    assert(again.promoted);
    assertEquals(again.meshRepin, undefined, 'same bytes, nothing to re-pin');
  });
});

Deno.test('nothing picked yet: the rig is kept, and the refusal says which verb', async () => {
  await withCharacter(async (dir) => {
    const src = `${dir}/rigged.glb`;
    await Deno.writeFile(src, Uint8Array.from([1]));
    const result = await promoteToCanonical(dir, src);
    assertEquals(result.promoted, false);
    assert(!result.promoted && result.reason === 'no-canonical-mesh');
    // the source is untouched - the rig's real work is never thrown away over
    // bookkeeping, which is the same rule the job's catch already followed
    assertEquals((await Deno.stat(src)).isFile, true);
  }, { picked: false });
});

Deno.test('an unreadable source is an io refusal carrying the real error', async () => {
  await withCharacter(async (dir) => {
    const result = await promoteToCanonical(dir, `${dir}/does-not-exist.glb`);
    assertEquals(result.promoted, false);
    assert(!result.promoted && result.reason === 'io');
    assert(!result.promoted && result.reason === 'io' && result.error instanceof Error);
  });
});
