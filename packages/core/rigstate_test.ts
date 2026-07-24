/**
 * P3-T3 acceptance: "jointEdits are journaled patches — undo works on them."
 *
 * The claim is not that a nudge is SAVED, it is that a nudge is UNDOABLE, and
 * the only way to prove that is to walk the same journal the CLI's `undo`
 * walks and land back on byte-identical bytes. A repair the user cannot take
 * back is a repair they will be afraid to try.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { CharacterId, RigState } from '@spritebook/schema';
import { ManifestPatchSchema, parseWith } from '@spritebook/schema';
import { applyPatchOps } from './journal.ts';
import { createWorkspace, workspacePaths } from './workspace.ts';
import { setRigState } from './receipts.ts';

const NOW = () => '2026-07-19T00:00:00Z';

function rig(over: Partial<RigState> = {}): RigState {
  return {
    track: 'B',
    backend: { modelId: 'unirig', version: '36842e2b' },
    skeletonProfile: 'generic',
    jointCount: 52,
    jointEdits: [],
    orientationFixes: [],
    accepted: false,
    ...over,
  };
}

async function workspace(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await createWorkspace({
    workspace: dir,
    characterId: 'knight' as CharacterId,
    displayName: 'knight',
    source: { kind: 'mesh', originalFilename: 'knight.glb', sha256: 'a'.repeat(64) },
    now: NOW,
  });
  return dir;
}

/** Replay the LAST journal patch's inverse, exactly as `spritebook undo` does. */
async function undoOnce(ws: string): Promise<void> {
  const paths = workspacePaths(ws);
  const patches = (await Deno.readTextFile(paths.journal))
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l, i) => parseWith(ManifestPatchSchema, JSON.parse(l), `journal line ${i + 1}`));
  const cursor = Number((await Deno.readTextFile(paths.cursor)).trim());
  assert(cursor > 0, 'nothing to undo');
  const doc = JSON.parse(await Deno.readTextFile(paths.manifest));
  const undone = applyPatchOps(doc, patches[cursor - 1].inverse);
  await Deno.writeTextFile(paths.manifest, JSON.stringify(undone, null, 2));
  await Deno.writeTextFile(paths.cursor, String(cursor - 1));
}

Deno.test('ACCEPTANCE: a joint edit is a journaled patch, and undo takes it back', async () => {
  const ws = await workspace();
  try {
    const paths = workspacePaths(ws);

    // 1. the rig lands
    await setRigState(ws, rig(), { now: NOW });
    const afterRig = await Deno.readTextFile(paths.manifest);
    const rigged = JSON.parse(afterRig);
    assertEquals(rigged.rig.jointCount, 52);
    assertEquals(rigged.rig.jointEdits, [], 'no repairs yet');

    // 2. the user nudges a shoulder, mirrored onto its partner
    await setRigState(
      ws,
      rig({
        jointEdits: [{ joint: 'clavicle_l', delta: [0, 0.02, 0.01], mirrored: true }],
      }),
      { now: NOW },
    );
    const edited = JSON.parse(await Deno.readTextFile(paths.manifest));
    assertEquals(edited.rig.jointEdits.length, 1);
    assertEquals(edited.rig.jointEdits[0].joint, 'clavicle_l');

    // the journal grew by exactly one replayable patch, with an inverse
    const lines = (await Deno.readTextFile(paths.journal)).split('\n').filter((l) => l);
    assertEquals(lines.length, 2, 'one patch per mutation');
    const last = JSON.parse(lines[1]);
    assert(Array.isArray(last.inverse) && last.inverse.length > 0, 'the patch carries its inverse');
    assert(
      String(last.label).toLowerCase().includes('joint'),
      `the label reads like history a human wants: "${last.label}"`,
    );

    // 3. THE POINT: undo takes the nudge back, byte for byte
    await undoOnce(ws);
    const undone = JSON.parse(await Deno.readTextFile(paths.manifest));
    assertEquals(undone.rig.jointEdits, [], 'the nudge is gone');
    assertEquals(undone.rig.jointCount, 52, 'the rig itself survives');
    assertEquals(
      canonical(undone),
      canonical(rigged),
      'the manifest is exactly what it was before the edit',
    );

    // 4. and undoing again takes the whole rig back
    await undoOnce(ws);
    const bare = JSON.parse(await Deno.readTextFile(paths.manifest));
    assertEquals(bare.rig, undefined, 'a character with no rig at all, as it began');
  } finally {
    await Deno.remove(ws, { recursive: true });
  }
});

Deno.test('orientation fixes are recorded for provenance too', async () => {
  const ws = await workspace();
  try {
    await setRigState(ws, rig({ orientationFixes: ['rotate-180', 'feet-ground'] }), { now: NOW });
    const m = JSON.parse(await Deno.readTextFile(workspacePaths(ws).manifest));
    assertEquals(m.rig.orientationFixes, ['rotate-180', 'feet-ground']);
  } finally {
    await Deno.remove(ws, { recursive: true });
  }
});

Deno.test('re-recording the identical rig is refused, so the journal has no no-ops', async () => {
  const ws = await workspace();
  try {
    await setRigState(ws, rig(), { now: NOW });
    let threw = false;
    try {
      await setRigState(ws, rig(), { now: NOW });
    } catch (err) {
      threw = true;
      assert(String(err).includes('already has'), `actionable: ${err}`);
    }
    assert(threw, 'an undo stack full of no-ops is an undo stack nobody trusts');
  } finally {
    await Deno.remove(ws, { recursive: true });
  }
});

/** Key-sorted JSON, so field ORDER cannot fake an inequality. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return val;
  });
}
