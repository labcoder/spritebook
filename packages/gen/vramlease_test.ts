/**
 * The lease, wired into a REAL gen job.
 *
 * The unit tests in @spritebook/core prove the protocol; this proves the
 * wiring, which is the part that has actually been missing — the queue's
 * in-process budget was correct and tested for a whole task while no
 * production code called it. So this asserts the two things a user would
 * notice: that a busy machine makes the job WAIT rather than OOM, that it
 * SAYS so on the job's own event stream, and that the claim is gone when the
 * job ends.
 *
 * The backend is the fixture generator with a `minVramGb` grafted on, because
 * the shipped fixture entry declares none (it is a synthetic CPU backend and
 * honestly claims nothing). That graft is the only fiction here: the job, the
 * catalog load, the gates, the lease and the release are all the real ones.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { CharacterId, JobEvent } from '@spritebook/schema';
import { vramCommittedGb } from '@spritebook/core';
import { runGenJob } from './gen.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IMAGE = `${REPO}spikes/trellis2/refs/bulma-front.png`;
const CATALOG = `${REPO}packages/registry/catalog/models.json`;
const SIDECAR = `${REPO}sidecar`;

/** the fields every gen job needs, so each case says only what it varies */
const base = (workspace: string) => ({
  jobId: 'gen',
  workspace,
  imagePath: IMAGE,
  modelId: 'fixture-gen',
  seed: 0,
  params: {},
  sidecarDir: SIDECAR,
  detectedVramGb: 24,
});

/** The bundled catalog with the fixture backend declaring 8 GiB. */
async function catalogClaiming(gb: number, into: string): Promise<string> {
  const doc = JSON.parse(await Deno.readTextFile(CATALOG));
  const fixture = doc.models.find((m: { id: string }) => m.id === 'fixture-gen');
  fixture.versions[0].minVramGb = gb;
  const path = `${into}/models.json`;
  await Deno.writeTextFile(path, JSON.stringify(doc));
  return path;
}

/** A live claim from another process, holding `gb` of the machine. */
async function blocker(dir: string, gb: number): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/1-9999-blocker.json`;
  await Deno.writeTextFile(
    path,
    JSON.stringify({ state: 'held', gb, at: 1, pid: 9999, jobId: 'other-process' }),
  );
  return path;
}

Deno.test('a busy machine makes gen WAIT, and the job says so', async () => {
  const tmp = await Deno.makeTempDir();
  const leaseDir = `${tmp}/leases`;
  try {
    const catalogPath = await catalogClaiming(8, tmp);
    const held = await blocker(leaseDir, 20); // 20 of 24 gone: 8 does not fit
    assertEquals(await vramCommittedGb(leaseDir), 20);

    const events: JobEvent[] = [];
    let releasedAt = -1;
    const job = runGenJob({
      ...base(`${tmp}/ws`),
      characterId: 'leased' as CharacterId,
      catalogPath,
      vramLeaseDir: leaseDir,
    });
    for await (const e of job) {
      events.push(e);
      // the generator is PAUSED here, so this is a deterministic "the other
      // process finished" rather than a race with a timer
      if (e.t === 'warn' && e.code === 'vram-wait' && releasedAt < 0) {
        releasedAt = events.length;
        await Deno.remove(held);
      }
    }

    const wait = events.find((e) => e.t === 'warn' && e.code === 'vram-wait');
    assert(wait !== undefined, `the job never said it was waiting: ${events.map((e) => e.t)}`);
    assert(
      (wait as Extract<JobEvent, { t: 'warn' }>).message.includes('8 GiB'),
      (wait as Extract<JobEvent, { t: 'warn' }>).message,
    );
    assert(
      (wait as Extract<JobEvent, { t: 'warn' }>).message.includes('other-process'),
      'and names who is ahead of it, so a human can tell what to wait for',
    );
    // it waited BEFORE doing the work, not after
    const started = events.findIndex((e) => e.t === 'progress');
    assert(started > releasedAt - 1, 'the wait came before the first progress step');

    assert(events.some((e) => e.t === 'done'), `the job finished: ${events.at(-1)?.t}`);
    assertEquals(await vramCommittedGb(leaseDir), 0, 'and gave its claim back');
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test('a free machine takes the claim silently and releases it', async () => {
  const tmp = await Deno.makeTempDir();
  const leaseDir = `${tmp}/leases`;
  try {
    const catalogPath = await catalogClaiming(8, tmp);
    const events: JobEvent[] = [];
    for await (
      const e of runGenJob({
        ...base(`${tmp}/ws`),
        characterId: 'quiet' as CharacterId,
        catalogPath,
        vramLeaseDir: leaseDir,
      })
    ) events.push(e);

    assertEquals(
      events.filter((e) => e.t === 'warn' && e.code === 'vram-wait').length,
      0,
      'no notice when there was nothing to wait for — the lease is not chatter',
    );
    assert(events.some((e) => e.t === 'done'));
    assertEquals(await vramCommittedGb(leaseDir), 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test('a backend that declares no VRAM takes no lease at all', async () => {
  // the shipped fixture entry: a synthetic CPU backend that honestly claims
  // nothing must not queue behind a GPU job
  const tmp = await Deno.makeTempDir();
  const leaseDir = `${tmp}/leases`;
  try {
    await blocker(leaseDir, 24); // the whole machine is taken
    const events: JobEvent[] = [];
    for await (
      const e of runGenJob({
        ...base(`${tmp}/ws`),
        characterId: 'cpu' as CharacterId,
        vramLeaseDir: leaseDir,
      })
    ) events.push(e);
    assert(events.some((e) => e.t === 'done'), 'it ran straight through a full machine');
    assertEquals(events.filter((e) => e.t === 'warn' && e.code === 'vram-wait').length, 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test('a failed job still gives its VRAM back', async () => {
  // the release is in a `finally`, and this is what proves it: a job that
  // leaked on the error path would shrink the machine on every failure
  const tmp = await Deno.makeTempDir();
  const leaseDir = `${tmp}/leases`;
  try {
    const catalogPath = await catalogClaiming(8, tmp);
    const events: JobEvent[] = [];
    for await (
      const e of runGenJob({
        ...base(`${tmp}/ws`),
        characterId: 'doomed' as CharacterId,
        imagePath: `${tmp}/there-is-no-such-image.png`,
        catalogPath,
        vramLeaseDir: leaseDir,
      })
    ) events.push(e);

    assert(events.some((e) => e.t === 'error'), 'it failed, which is the point');
    assertEquals(await vramCommittedGb(leaseDir), 0, 'and still released');
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
