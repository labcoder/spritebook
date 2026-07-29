/**
 * `bodies` on the receipt, and what `pick` does with it.
 *
 * The measurement that motivated this: the SAME image at different gen seeds
 * lands on different answers. `robot-astro` came back as two body-sized shells
 * at seed 7 (60.4% / 20.0% of its vertices — its hands came off) and as one at
 * seeds 100 and 201 (78.9%, 89.8%). Bulma was one body at every seed tried. So
 * "generate a few, take the connected one" is a real strategy, and it only
 * works if each result carries the number.
 *
 * These tests are synthetic on purpose — no sidecar, no GPU. What they pin is
 * the DECISION `pick` makes from the recorded number, which is the part a
 * backend swap must not change. gen's own measurement is covered by
 * components_test.ts in @spritebook/importer, on real geometry.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { Document, NodeIO } from '@gltf-transform/core';
import type { GenerationResult, JobEvent } from '@spritebook/schema';
import { appendGenerationResult, createWorkspace, resultPaths } from '@spritebook/core';
import type { CharacterId } from '@spritebook/schema';
import { runPickJob } from './mod.ts';

async function collect(it: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** One triangle, enough to be a promotable glb. */
async function triangleGlb(): Promise<Uint8Array> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const pos = doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  );
  const prim = doc.createPrimitive().setAttribute('POSITION', pos);
  const mesh = doc.createMesh().addPrimitive(prim);
  const node = doc.createNode('body').setMesh(mesh);
  doc.createScene().addChild(node);
  return await new NodeIO().writeBinary(doc);
}

const sha = 'a'.repeat(64);

function receipt(id: string, bodies?: number): GenerationResult {
  return {
    id,
    backend: { modelId: 'fixture-gen', version: '1.0.0' },
    params: {},
    seed: 7,
    startedAt: '2026-07-29T00:00:00.000Z',
    wallTimeS: 1,
    output: {
      gltfSha256: sha,
      tris: 1,
      kind: 'mesh',
      ...(bodies !== undefined ? { bodies } : {}),
    },
    discarded: false,
  };
}

/** A workspace holding the given receipts, each with a real model.glb. */
async function workspaceWith(receipts: GenerationResult[]): Promise<string> {
  const ws = await Deno.makeTempDir({ prefix: 'sb-bodies-' });
  await createWorkspace({
    workspace: ws,
    characterId: 'ch-bodies' as CharacterId,
    displayName: 'bodies',
    source: { kind: 'image', originalFilename: 'x.png', sha256: sha },
  });
  const glb = await triangleGlb();
  for (const r of receipts) {
    await appendGenerationResult(ws, r);
    const rp = resultPaths(ws, r.id);
    await Deno.mkdir(rp.dir, { recursive: true });
    await Deno.writeFile(rp.model, glb);
  }
  return ws;
}

function warnOf(events: JobEvent[], code: string): string | undefined {
  const w = events.find((e) => e.t === 'warn' && e.code === code);
  return w && w.t === 'warn' ? w.message : undefined;
}

Deno.test('picking a split body warns, and names the connected sibling', async () => {
  // the astro case exactly: seed 7 split, seed 100 did not
  const ws = await workspaceWith([receipt('r1', 2), receipt('r2', 1)]);
  const events = await collect(runPickJob({ jobId: 'pick', workspace: ws, resultId: 'r1' }));

  const msg = warnOf(events, 'picked-multi-body');
  assert(msg, 'a two-body pick is warned about');
  assert(msg.includes('2 DETACHED'), `the count is in the message: ${msg}`);
  assert(msg.includes('"r2"'), `the connected sibling is named: ${msg}`);
  assert(msg.includes('pick --result r2'), `and the command to take it: ${msg}`);

  // it still promotes what it was asked to promote — this is advice, not a veto
  assert(events.some((e) => e.t === 'done'), 'the pick still succeeds');
  assert(
    events.some((e) => e.t === 'artifact' && e.kind === 'canonical-model'),
    'and canonical/model.glb is written',
  );
  await Deno.remove(ws, { recursive: true });
});

Deno.test('no connected sibling: the advice is to re-generate, not to re-pick', async () => {
  const ws = await workspaceWith([receipt('r1', 2), receipt('r2', 3)]);
  const events = await collect(runPickJob({ jobId: 'pick', workspace: ws, resultId: 'r1' }));

  const msg = warnOf(events, 'picked-multi-body');
  assert(msg, 'still warned');
  assert(!msg.includes('pick --result r2'), `r2 is split too, so it is not offered: ${msg}`);
  assert(msg.includes('another seed'), `the remedy is a new generation: ${msg}`);
  await Deno.remove(ws, { recursive: true });
});

Deno.test('a discarded sibling is not offered as the alternative', async () => {
  const ws = await workspaceWith([receipt('r1', 2), { ...receipt('r2', 1), discarded: true }]);
  const events = await collect(runPickJob({ jobId: 'pick', workspace: ws, resultId: 'r1' }));

  const msg = warnOf(events, 'picked-multi-body');
  assert(msg, 'still warned');
  assert(!msg.includes('"r2"'), `pick would refuse r2 outright, so it is not advice: ${msg}`);
  await Deno.remove(ws, { recursive: true });
});

Deno.test('a single body is silent, and so is a result that never measured one', async () => {
  const one = await workspaceWith([receipt('r1', 1)]);
  assertEquals(
    warnOf(
      await collect(runPickJob({ jobId: 'pick', workspace: one, resultId: 'r1' })),
      'picked-multi-body',
    ),
    undefined,
    'one body says nothing',
  );

  // absent is UNKNOWN, not 1 and not 2: a result generated before this was
  // measured must not produce a warning OR a recommendation on no evidence
  const old = await workspaceWith([receipt('r1'), receipt('r2', 1)]);
  assertEquals(
    warnOf(
      await collect(runPickJob({ jobId: 'pick', workspace: old, resultId: 'r1' })),
      'picked-multi-body',
    ),
    undefined,
    'an unmeasured result is not accused of being split',
  );

  await Deno.remove(one, { recursive: true });
  await Deno.remove(old, { recursive: true });
});

Deno.test('zero bodies is reported as fragments, not rounded up to one', async () => {
  const ws = await workspaceWith([receipt('r1', 0)]);
  const msg = warnOf(
    await collect(runPickJob({ jobId: 'pick', workspace: ws, resultId: 'r1' })),
    'picked-multi-body',
  );
  assert(msg, 'a mesh with no body-sized piece is warned about');
  assert(msg.includes('NO body-sized piece'), `and named for what it is: ${msg}`);
  await Deno.remove(ws, { recursive: true });
});
