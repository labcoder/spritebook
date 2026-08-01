/**
 * The machine-wide VRAM lease.
 *
 * The protocol is entirely files, so two `acquireVramLease` calls against one
 * directory exercise exactly the code two PROCESSES exercise — the algorithm
 * has no notion of a process beyond the pid it writes down. What that does not
 * cover is OS-level interleaving of the directory mutex, so there is a real
 * two-process test at the bottom, gated the way the other spawn-based lanes
 * are (`deno task test` grants `--allow-run` for nvidia-smi and uv only).
 *
 * A killed holder is simulated the way a killed holder actually looks: a claim
 * file on disk whose heartbeat stopped. There is no way to leave a more
 * authentic corpse than that.
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { acquireVramLease, defaultLeaseDir, vramCommittedGb } from './vramlease.ts';

const FAST = { pollMs: 20, heartbeatMs: 40, staleMs: 160 } as const;

async function tmp(): Promise<string> {
  return await Deno.makeTempDir();
}

Deno.test('with no budget there is no lease, and no directory', async () => {
  // detection returning null must not invent a ceiling that refuses work the
  // card can actually do
  const dir = await tmp();
  try {
    for (const budgetGb of [null, undefined, 0]) {
      const lease = await acquireVramLease({ gb: 16, jobId: 'gen', budgetGb, dir, ...FAST });
      assertEquals(lease.path, null, `budget ${budgetGb}: nothing was written`);
      await lease.release();
    }
    // and a job with no claim is the same no-op
    const none = await acquireVramLease({ gb: 0, jobId: 'prep', budgetGb: 24, dir, ...FAST });
    assertEquals(none.path, null);
    await none.release();
    assertEquals([...Deno.readDirSync(dir)].length, 0, 'no files at all');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a claim bigger than the machine is refused, not waited on', async () => {
  const dir = await tmp();
  try {
    await assertRejects(
      () => acquireVramLease({ gb: 32, jobId: 'hunyuan', budgetGb: 24, dir, ...FAST }),
      Error,
      'could never start',
    );
    assertEquals([...Deno.readDirSync(dir)].filter((e) => e.isFile).length, 0, 'and left nothing');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('two claims that fit both hold; a third waits for a release', async () => {
  const dir = await tmp();
  try {
    const a = await acquireVramLease({ gb: 8, jobId: 'a', budgetGb: 24, dir, ...FAST });
    const b = await acquireVramLease({ gb: 8, jobId: 'b', budgetGb: 24, dir, ...FAST });
    assertEquals(await vramCommittedGb(dir, FAST.staleMs), 16);

    let waited: string | null = null;
    const third = acquireVramLease({
      gb: 16,
      jobId: 'c',
      budgetGb: 24,
      dir,
      ...FAST,
      onWait: (r) => (waited = r),
    });
    await new Promise((r) => setTimeout(r, 80));
    assertEquals(await vramCommittedGb(dir, FAST.staleMs), 16, 'c did not sneak in');
    assert(waited !== null, 'and it SAID it was waiting');
    assert(String(waited).includes('16 GiB'), waited!);
    assert(String(waited).includes("8 GiB of the machine's 24 GiB is free"), waited!);

    await a.release();
    await b.release();
    const c = await third;
    assertEquals(await vramCommittedGb(dir, FAST.staleMs), 16, 'c holds the card now');
    await c.release();
    assertEquals(await vramCommittedGb(dir, FAST.staleMs), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('the OLDEST waiter goes first, even when a later one would fit', async () => {
  // the cross-process form of the queue's FIFO rule: without it a 20 GiB job
  // waits behind every 1 GiB job anyone starts, forever
  const dir = await tmp();
  try {
    const holder = await acquireVramLease({ gb: 8, jobId: 'holder', budgetGb: 24, dir, ...FAST });

    const order: string[] = [];
    const big = acquireVramLease({ gb: 20, jobId: 'big', budgetGb: 24, dir, ...FAST })
      .then((l) => {
        order.push('big');
        return l;
      });
    await new Promise((r) => setTimeout(r, 40)); // big arrives first, and waits
    const smalls = [0, 1, 2].map((i) =>
      acquireVramLease({ gb: 1, jobId: `small-${i}`, budgetGb: 24, dir, ...FAST }).then((l) => {
        order.push(`small-${i}`);
        return l;
      })
    );

    await new Promise((r) => setTimeout(r, 80));
    assertEquals(order, [], 'nothing is promoted past the waiter that does not fit');

    await holder.release();
    const leases = await Promise.all([big, ...smalls]);
    assertEquals(order[0], 'big', 'the oldest waiter went first');
    assertEquals(order.length, 4, 'and everyone eventually ran');
    for (const l of leases) await l.release();
    assertEquals(await vramCommittedGb(dir, FAST.staleMs), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a KILLED holder gives its VRAM back when its heartbeat lapses', async () => {
  // what a killed process actually leaves behind: a held claim whose mtime
  // stops moving. Nothing else about it is distinguishable from a live one.
  const dir = await tmp();
  try {
    const corpse = `${dir}/1000-4242-dead.json`;
    await Deno.writeTextFile(
      corpse,
      JSON.stringify({ state: 'held', gb: 20, at: 1000, pid: 4242, jobId: 'killed' }),
    );
    const old = new Date(Date.now() - 60_000);
    await Deno.utime(corpse, old, old);

    assertEquals(await vramCommittedGb(dir, FAST.staleMs), 0, 'a stale claim commits nothing');
    // and the reaper actually removed the file rather than only ignoring it
    assertEquals(await Deno.stat(corpse).catch(() => null), null, 'the corpse was buried');

    const lease = await acquireVramLease({ gb: 24, jobId: 'next', budgetGb: 24, dir, ...FAST });
    assertEquals(await vramCommittedGb(dir, FAST.staleMs), 24, 'the whole budget came back');
    await lease.release();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a LIVE holder is not reaped while it heartbeats', async () => {
  // the other half of the same rule: a long generate must not have its budget
  // taken away underneath it just for taking a while
  const dir = await tmp();
  try {
    const lease = await acquireVramLease({ gb: 20, jobId: 'slow', budgetGb: 24, dir, ...FAST });
    // sit for several stale windows; the heartbeat should keep it alive
    await new Promise((r) => setTimeout(r, FAST.staleMs * 3));
    assertEquals(await vramCommittedGb(dir, FAST.staleMs), 20, 'still held after 3 stale windows');
    await lease.release();
    assertEquals(await vramCommittedGb(dir, FAST.staleMs), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a stale directory mutex does not wedge the machine', async () => {
  // the lock holder dying between mkdir and remove is the one failure that
  // would stop every SpriteBook process on the box
  const dir = await tmp();
  try {
    await Deno.mkdir(`${dir}/.lock`, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await Deno.utime(`${dir}/.lock`, old, old);

    const lease = await acquireVramLease({ gb: 8, jobId: 'after', budgetGb: 24, dir, ...FAST });
    assertEquals(await vramCommittedGb(dir, FAST.staleMs), 8);
    await lease.release();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('cancelling while waiting leaves no claim behind', async () => {
  const dir = await tmp();
  try {
    const holder = await acquireVramLease({ gb: 20, jobId: 'holder', budgetGb: 24, dir, ...FAST });
    const ac = new AbortController();
    const pending = acquireVramLease({
      gb: 20,
      jobId: 'cancelled',
      budgetGb: 24,
      dir,
      ...FAST,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 60));
    ac.abort();
    await assertRejects(() => pending, Error, 'Cancelled while waiting');
    // the abandoned claim is gone immediately, not after a stale window
    const files = [...Deno.readDirSync(dir)].filter((e) => e.isFile);
    assertEquals(files.length, 1, `only the holder remains: ${files.map((f) => f.name)}`);
    await holder.release();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a timeout gives up and says what it was waiting for', async () => {
  const dir = await tmp();
  try {
    const holder = await acquireVramLease({ gb: 20, jobId: 'holder', budgetGb: 24, dir, ...FAST });
    await assertRejects(
      () =>
        acquireVramLease({
          gb: 20,
          jobId: 'impatient',
          budgetGb: 24,
          dir,
          ...FAST,
          timeoutMs: 120,
        }),
      Error,
      'Waited',
    );
    await holder.release();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('the default directory is machine-wide, not per-workspace', () => {
  // two Studio-spawned processes in different workspaces must land in the same
  // place or the whole exercise is decorative
  const d = defaultLeaseDir();
  assert(d.endsWith('spritebook-vram'), d);
  assert(!d.includes('character'), 'nothing workspace-shaped is in the path');
});

Deno.test('ACCEPTANCE: two real PROCESSES contend for one budget', async () => {
  // Everything above proves the protocol; only this proves the OS agrees —
  // that two `deno` processes racing the directory mutex do not both take the
  // card. Gated because `deno task test` grants --allow-run for nvidia-smi and
  // uv only; run it with:
  //
  //   SPRITEBOOK_LEASE_ITEST=1 deno test --allow-all packages/core/vramlease_test.ts
  if (Deno.env.get('SPRITEBOOK_LEASE_ITEST') !== '1') {
    console.log('skip: set SPRITEBOOK_LEASE_ITEST=1 to run the two-process lease test');
    return;
  }
  const dir = await tmp();
  const holder = new URL('./fixtures/leaseholder.ts', import.meta.url).pathname
    .replace(/^\/([A-Za-z]:)/, '$1');
  try {
    // 16 + 16 does not fit in 24: exactly one may hold at a time
    const run = (jobId: string, holdMs: number) =>
      new Deno.Command(Deno.execPath(), {
        args: ['run', '--allow-all', holder, dir, '16', jobId, String(holdMs)],
        stdout: 'piped',
        stderr: 'piped',
      }).output();

    const [a, b] = await Promise.all([run('proc-a', 700), run('proc-b', 700)]);
    const out = (r: Deno.CommandOutput) => new TextDecoder().decode(r.stdout);
    const err = (r: Deno.CommandOutput) => new TextDecoder().decode(r.stderr);
    assertEquals(a.code, 0, err(a));
    assertEquals(b.code, 0, err(b));

    const lines = [...out(a).split('\n'), ...out(b).split('\n')].map((l) => l.trim()).filter(
      Boolean,
    );
    assertEquals(lines.filter((l) => l.startsWith('HELD')).length, 2, 'both eventually ran');
    assertEquals(
      lines.filter((l) => l.startsWith('WAIT')).length,
      1,
      `exactly one had to wait — if neither did, both took the card: ${lines.join(' | ')}`,
    );
    // the loser waited for the winner: it can only have been admitted after a
    // release, which means the OS honoured the mutex
    const waiter = lines.find((l) => l.startsWith('WAIT'))!;
    assert(waiter.includes('16 GiB'), waiter);
    assertEquals(await vramCommittedGb(dir, 240), 0, 'and both gave it back');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
