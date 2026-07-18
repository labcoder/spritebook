/**
 * Poses reader unit tests (no GPU): the frozen byte format round-trips, errors
 * are actionable, and name-mapping behaves. The cross-package write->read->
 * render parity proof lives in the anim integration tests (P3-T1 Phase 2).
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { mapPosesJoints, readPoses } from './poses.ts';

function canonicalHeader(h: Record<string, unknown>): Uint8Array {
  const sorted = Object.fromEntries(Object.entries(h).sort(([a], [b]) => a < b ? -1 : 1));
  return new TextEncoder().encode(JSON.stringify(sorted) + '\n');
}

async function writePosesFile(
  path: string,
  header: Record<string, unknown>,
  data: Float32Array,
): Promise<void> {
  const head = canonicalHeader(header);
  const blob = new Uint8Array(data.buffer.slice(0), 0, data.byteLength);
  const out = new Uint8Array(head.length + blob.length);
  out.set(head, 0);
  out.set(blob, head.length);
  await Deno.writeFile(path, out);
}

Deno.test('poses: round-trip preserves header and every float', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const joints = ['root', 'pelvis'];
    const frames = 3;
    const data = Float32Array.from({ length: frames * joints.length * 16 }, (_v, i) => i / 7);
    const path = `${dir}/poses-idle.bin`;
    await writePosesFile(path, { clipId: 'idle', frames, jointNames: joints, version: 1 }, data);

    const r = await readPoses(path);
    assertEquals(r.header.clipId, 'idle');
    assertEquals(r.header.frames, 3);
    assertEquals(r.header.jointNames, joints);
    assertEquals([...r.data], [...data], 'blob bytes identical');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('poses: wrong version and truncated blob are actionable errors', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const p1 = `${dir}/v2.bin`;
    await writePosesFile(
      p1,
      { clipId: 'x', frames: 1, jointNames: ['a'], version: 2 },
      new Float32Array(16),
    );
    await assertRejects(() => readPoses(p1), Error, 'version');

    const p2 = `${dir}/short.bin`;
    await writePosesFile(
      p2,
      { clipId: 'x', frames: 2, jointNames: ['a'], version: 1 },
      new Float32Array(16),
    );
    await assertRejects(() => readPoses(p2), Error, 'expected');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('poses: joints map by NAME; unmatched -> -1', () => {
  const map = mapPosesJoints(['pelvis', 'spine_01', 'tail'], {
    clipId: 'x',
    frames: 1,
    jointNames: ['root', 'pelvis', 'spine_01'],
    version: 1,
  });
  assertEquals([...map], [1, 2, -1], 'asset order preserved; tail has no pose track');
  assert(map instanceof Int32Array);
});
