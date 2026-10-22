import { promises as fs } from 'node:fs';
import { test } from 'node:test';
/**
 * Numeric validation for the humanoid retarget core (P3-T1) — the
 * animation-retargeting skill's "numbers first, eyeballs second" as tests.
 * World poses are recomputed with an INDEPENDENT forward kinematics over the
 * frozen contracts data (quat.ts primitives only), so a composition bug inside
 * retarget.ts cannot validate itself.
 *
 * Measured ground truth behind the tolerances (fixtures at this commit):
 * - source pelvis rest world Y 0.9167 m; source foot rest world Y 0.1037 m
 * - Walk_Loop: 41-frame union grid; source pelvis world spans X 0.0708 /
 *   Y 0.0526 / Z 0.0003 m (IN-PLACE variant — no forward drift; the forward
 *   root motion lives in UAL's RM clips); knee flexion range L 1.2931 /
 *   R 1.3739 rad
 * - hipScale: normal 0.98178, tall-thin 1.25450, short-chunky 0.54543
 * - footContactMaxErrM after correction: 0.0023 / 0.0031 / 0.0011 m
 * - per-frame |flexion(src) − flexion(tgt)| max 0.0732 rad (rest-direction
 *   mismatch: UAL rests with a ~4° knee pre-bend, fixture rigs rest straight)
 * - A_TPose null transfer: 0 rad deviation, pelvis dev < 3e-8 m
 */
import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { NodeIO } from '@gltf-transform/core';
import type { Clip, RetargetResult, SkeletonRest } from './dist/contracts.js';
import { loadClip, loadSkeletonRest, UAL_HUMANOID } from './dist/profile.js';
import { CONTACT_EPS_M, measureRestFacingYaw, retargetClip } from './dist/retarget.js';
import {
  qAngle,
  qAxisAngle,
  qFromMat4,
  qMul,
  qNormalize,
  qRotate,
  qSlerp,
  qToMat4,
  type Quat,
  vAdd,
  type Vec3,
} from './dist/quat.js';

// ---------------------------------------------------------------------------
// Independent forward kinematics over the frozen contracts
// ---------------------------------------------------------------------------

interface FkJoint {
  parent: string;
  rot: Quat;
  pos: Vec3;
}
interface FkSkeleton {
  order: string[];
  local: Map<string, FkJoint>;
}

function fkRest(rest: SkeletonRest): FkSkeleton {
  const local = new Map<string, FkJoint>();
  for (const [name, m] of rest.locals) {
    local.set(name, {
      parent: rest.parents.get(name) ?? '',
      rot: qFromMat4(m),
      pos: [m[12], m[13], m[14]],
    });
  }
  const order: string[] = [];
  const placed = new Set<string>();
  let rem = [...local.keys()];
  while (rem.length > 0) {
    const ready = rem.filter((n) => {
      const p = local.get(n)!.parent;
      return p === '' || placed.has(p);
    });
    assert(ready.length > 0, 'rest skeleton has a parent cycle');
    for (const n of ready) {
      order.push(n);
      placed.add(n);
    }
    rem = rem.filter((n) => !placed.has(n));
  }
  return { order, local };
}

function keyBefore(times: Float32Array, t: number): number {
  let i = 0;
  while (i + 1 < times.length && times[i + 1] <= t) i++;
  return i;
}

/** World positions/orientations of every joint at time t (LINEAR/STEP). */
function samplePose(
  clip: Clip,
  sk: FkSkeleton,
  t: number,
): { rot: Map<string, Quat>; pos: Map<string, Vec3> } {
  const rot = new Map<string, Quat>();
  const pos = new Map<string, Vec3>();
  for (const n of sk.order) {
    const j = sk.local.get(n)!;
    const tr = clip.tracks.get(n);
    let lr = j.rot;
    let lp = j.pos;
    if (tr?.rotations) {
      const i = keyBefore(tr.times, t);
      const r = tr.rotations;
      const a: Quat = [r[i * 4], r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3]];
      if (tr.interpolation === 'STEP' || i === tr.times.length - 1 || t <= tr.times[i]) lr = a;
      else {
        const u = (t - tr.times[i]) / (tr.times[i + 1] - tr.times[i]);
        lr = qSlerp(a, [r[i * 4 + 4], r[i * 4 + 5], r[i * 4 + 6], r[i * 4 + 7]], u);
      }
    }
    if (tr?.translations) {
      const i = keyBefore(tr.times, t);
      const v = tr.translations;
      const a: Vec3 = [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
      if (tr.interpolation === 'STEP' || i === tr.times.length - 1 || t <= tr.times[i]) lp = a;
      else {
        const u = (t - tr.times[i]) / (tr.times[i + 1] - tr.times[i]);
        lp = [
          a[0] + (v[i * 3 + 3] - a[0]) * u,
          a[1] + (v[i * 3 + 4] - a[1]) * u,
          a[2] + (v[i * 3 + 5] - a[2]) * u,
        ];
      }
    }
    if (j.parent === '') {
      rot.set(n, lr);
      pos.set(n, lp);
    } else {
      const pr = rot.get(j.parent)!;
      rot.set(n, qNormalize(qMul(pr, lr)));
      pos.set(n, vAdd(pos.get(j.parent)!, qRotate(pr, lp)));
    }
  }
  return { rot, pos };
}

/** Hinge angle (rad) between the thigh->calf and calf->foot world segments. */
function flexion(pos: Map<string, Vec3>, side: 'l' | 'r'): number {
  const p = (n: string) => pos.get(`${n}_${side}`)!;
  const u: Vec3 = [
    p('calf')[0] - p('thigh')[0],
    p('calf')[1] - p('thigh')[1],
    p('calf')[2] - p('thigh')[2],
  ];
  const v: Vec3 = [
    p('foot')[0] - p('calf')[0],
    p('foot')[1] - p('calf')[1],
    p('foot')[2] - p('calf')[2],
  ];
  const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) /
    (Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2]));
  return Math.acos(Math.min(1, Math.max(-1, d)));
}

const EMPTY_CLIP: Clip = { id: 'rest', duration: 0, tracks: new Map() };

// ---------------------------------------------------------------------------
// Fixtures (loaded once)
// ---------------------------------------------------------------------------

interface Fixtures {
  ualRest: SkeletonRest;
  walk: Clip;
  tpose: Clip;
  srcSk: FkSkeleton;
  srcRestPos: Map<string, Vec3>;
  targets: Array<[string, SkeletonRest]>;
}

let fxP: Promise<Fixtures> | undefined;
function fx(): Promise<Fixtures> {
  fxP ??= (async () => {
    const io = new NodeIO();
    const dir = new URL('./fixtures/', import.meta.url);
    const read = async (name: string) =>
      await io.readBinary(new Uint8Array(await fs.readFile(new URL(name, dir))));
    const ualDoc = await read('ual-subset.glb');
    const ualRest = loadSkeletonRest(ualDoc);
    const srcSk = fkRest(ualRest);
    const targets: Array<[string, SkeletonRest]> = [];
    for (const name of ['normal', 'tall-thin', 'short-chunky']) {
      targets.push([name, loadSkeletonRest(await read(`humanoid-${name}.glb`))]);
    }
    return {
      ualRest,
      walk: loadClip(ualDoc, 'Walk_Loop', 'walk'),
      tpose: loadClip(ualDoc, 'A_TPose', 'tpose'),
      srcSk,
      srcRestPos: samplePose(EMPTY_CLIP, srcSk, 0).pos,
      targets,
    };
  })();
  return fxP;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('facing yaw: measured ~0 for UAL and all three fixture bodies (never assumed)', async () => {
  const f = await fx();
  assert(Math.abs(measureRestFacingYaw(f.ualRest, UAL_HUMANOID)) < 1e-6, 'source yaw ~0');
  for (const [name, rest] of f.targets) {
    assert(Math.abs(measureRestFacingYaw(rest, UAL_HUMANOID)) < 1e-6, `${name} yaw ~0`);
  }
});

test('hipScale: pelvis rest-height ratio, per fixture body', async () => {
  const f = await fx();
  const srcHipY = f.srcRestPos.get('pelvis')![1]; // measured 0.9167 m
  assertAlmostEquals(srcHipY, 0.9167, 1e-3);
  const expected: Record<string, number> = {
    normal: 0.98178,
    'tall-thin': 1.2545,
    'short-chunky': 0.54543,
  };
  for (const [name, rest] of f.targets) {
    const res = retargetClip(f.walk, f.ualRest, rest, UAL_HUMANOID);
    const tgtHipY = samplePose(EMPTY_CLIP, fkRest(rest), 0).pos.get('pelvis')![1];
    assertAlmostEquals(res.stats.hipScale, tgtHipY / srcHipY, 1e-9, `${name}: ratio`);
    assertAlmostEquals(res.stats.hipScale, expected[name], 1e-4, `${name}: measured anchor`);
  }
});

test('Walk_Loop: knee flexion transfers onto all three bodies (a static result fails)', async () => {
  const f = await fx();
  for (const [name, rest] of f.targets) {
    const res = retargetClip(f.walk, f.ualRest, rest, UAL_HUMANOID);
    const tsk = fkRest(rest);
    const times = res.clip.tracks.get('calf_l')!.times;
    for (const side of ['l', 'r'] as const) {
      const srcF: number[] = [];
      const tgtF: number[] = [];
      let maxDiff = 0;
      for (const t of times) {
        const s = flexion(samplePose(f.walk, f.srcSk, t).pos, side);
        const g = flexion(samplePose(res.clip, tsk, t).pos, side);
        srcF.push(s);
        tgtF.push(g);
        maxDiff = Math.max(maxDiff, Math.abs(s - g));
      }
      const range = (a: number[]) => Math.max(...a) - Math.min(...a);
      const srcRange = range(srcF);
      const tgtRange = range(tgtF);
      // measured: source ranges 1.2931 (L) / 1.3739 (R); target matches < 1e-4
      assert(srcRange > 1.2, `${name}/${side}: source flexes substantially (${srcRange})`);
      assert(tgtRange > 1.0, `${name}/${side}: target is not static (${tgtRange})`);
      assert(
        Math.abs(tgtRange - srcRange) < 0.02,
        `${name}/${side}: flexion range matches source (src ${srcRange}, tgt ${tgtRange})`,
      );
      // measured per-frame ceiling 0.0732 rad — the rigs' rest-direction mismatch
      assert(maxDiff < 0.12, `${name}/${side}: per-frame flexion tracks source (max ${maxDiff})`);
    }
  }
});

test('Walk_Loop: an arms-down bind pose follows the clip instead of doubling the arm drop', async () => {
  const f = await fx();
  const normal = f.targets[0][1];
  const rest: SkeletonRest = { parents: new Map(normal.parents), locals: new Map(normal.locals) };
  for (const [side, sign] of [['l', 1], ['r', -1]] as const) {
    const name = `upperarm_${side}`, matrix = rest.locals.get(name)!;
    const rotated = qToMat4(qMul(qAxisAngle([0, 0, 1], -sign * Math.PI / 3), qFromMat4(matrix)));
    rotated.set(matrix.subarray(12, 15), 12);
    rest.locals.set(name, rotated);
  }
  const result = retargetClip(f.walk, f.ualRest, rest, UAL_HUMANOID);
  const target = fkRest(rest);
  for (const t of result.clip.tracks.get('pelvis')!.times) {
    const src = samplePose(f.walk, f.srcSk, t).pos, tgt = samplePose(result.clip, target, t).pos;
    for (const side of ['l', 'r']) {
      const direction = (pose: Map<string, Vec3>) => {
        const a = pose.get(`upperarm_${side}`)!, b = pose.get(`lowerarm_${side}`)!;
        const d = b.map((v, i) => v - a[i]);
        return d.map((v) => v / Math.hypot(...d));
      };
      const a = direction(src), b = direction(tgt);
      assert(
        a.reduce((sum, v, i) => sum + v * b[i], 0) > 0.99,
        `${side}: arm direction matches the clip at ${t}`,
      );
    }
  }
});

test('Walk_Loop: source ground-contact frames keep target feet planted within 2 cm', async () => {
  const f = await fx();
  for (const [name, rest] of f.targets) {
    const res = retargetClip(f.walk, f.ualRest, rest, UAL_HUMANOID);
    const tsk = fkRest(rest);
    const tgtRestPos = samplePose(EMPTY_CLIP, tsk, 0).pos;
    const times = res.clip.tracks.get('pelvis')!.times;
    let contactFrames = 0;
    let maxAllFeet = 0;
    let maxLowest = 0;
    for (const t of times) {
      const sp = samplePose(f.walk, f.srcSk, t).pos;
      const tp = samplePose(res.clip, tsk, t).pos;
      let lowest = Infinity;
      for (const foot of UAL_HUMANOID.feet) {
        const grounded = sp.get(foot)![1] <= f.srcRestPos.get(foot)![1] + CONTACT_EPS_M;
        if (!grounded) continue;
        const rel = tp.get(foot)![1] - tgtRestPos.get(foot)![1];
        maxAllFeet = Math.max(maxAllFeet, Math.abs(rel));
        lowest = Math.min(lowest, rel);
      }
      if (lowest < Infinity) {
        contactFrames++;
        maxLowest = Math.max(maxLowest, Math.abs(lowest));
      }
    }
    assert(contactFrames >= 10, `${name}: contact rule matches frames (${contactFrames})`);
    assert(maxAllFeet < 0.02, `${name}: every contact foot within 2 cm (max ${maxAllFeet})`);
    assert(
      res.stats.footContactMaxErrM < 0.02,
      `${name}: stats under tolerance (${res.stats.footContactMaxErrM})`,
    );
    assertAlmostEquals(
      res.stats.footContactMaxErrM,
      maxLowest,
      1e-3,
      `${name}: stats agree with independent FK`,
    );
  }
});

test('Walk_Loop: hip sway and bob transfer scaled by hipScale (in-place variant: no forward drift)', async () => {
  const f = await fx();
  const spans = (clip: Clip, sk: FkSkeleton, times: Float32Array) => {
    const mins: Vec3 = [Infinity, Infinity, Infinity];
    const maxs: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const t of times) {
      const p = samplePose(clip, sk, t).pos.get('pelvis')!;
      for (let c = 0; c < 3; c++) {
        mins[c] = Math.min(mins[c], p[c]);
        maxs[c] = Math.max(maxs[c], p[c]);
      }
    }
    return [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]] as Vec3;
  };
  const anyTimes = (await fx()).walk.tracks.get('pelvis')!.times;
  const src = spans(f.walk, f.srcSk, anyTimes);
  // NOTE for the integrator: this Walk_Loop is the in-place variant — the
  // pelvis carries lateral sway (X) and vertical bob (Y) but no forward root
  // motion (measured Z span 0.0003 m). Sway/bob must transfer scaled; forward
  // trajectory assertions belong to the RM clips.
  assert(src[0] > 0.05, `source has lateral sway (${src[0]})`);
  assert(src[1] > 0.04, `source has vertical bob (${src[1]})`);
  assert(src[2] < 0.01, `Walk_Loop is in place (${src[2]})`);
  for (const [name, rest] of f.targets) {
    const res = retargetClip(f.walk, f.ualRest, rest, UAL_HUMANOID);
    const s = res.stats.hipScale;
    const tgt = spans(res.clip, fkRest(rest), res.clip.tracks.get('pelvis')!.times);
    assertAlmostEquals(tgt[0], src[0] * s, 0.002, `${name}: sway scales by hipScale`);
    // bob = scaled source bob +- the foot-correction offset (measured <= 11 mm)
    assertAlmostEquals(tgt[1], src[1] * s, 0.015, `${name}: bob scales by hipScale`);
    assert(tgt[2] < 0.005, `${name}: still in place (${tgt[2]})`);
  }
});

test('Walk_Loop: mapping report is exact — 21 core mapped, 44 extended dropped and reported', async () => {
  const f = await fx();
  for (const [name, rest] of f.targets) {
    const res = retargetClip(f.walk, f.ualRest, rest, UAL_HUMANOID);
    assertEquals(res.report.mapped, [...UAL_HUMANOID.core].sort(), name);
    assertEquals(res.report.unmappedTarget, [], name);
    assertEquals(res.report.unmappedSource, [...UAL_HUMANOID.extended].sort(), name);
    // track shape: shared 41-frame grid, LINEAR, hips-only translation, no scales
    assertEquals(res.clip.tracks.size, 21, name);
    assertEquals(res.clip.duration, f.walk.duration, name);
    for (const [jn, tr] of res.clip.tracks) {
      assertEquals(tr.times.length, 41, `${name}/${jn}: union grid`);
      assertEquals(tr.interpolation, 'LINEAR', `${name}/${jn}`);
      assertEquals(tr.rotations!.length, 41 * 4, `${name}/${jn}`);
      assertEquals(tr.scales, undefined, `${name}/${jn}: scales dropped`);
      if (jn === UAL_HUMANOID.hips) {
        assertEquals(tr.translations!.length, 41 * 3, `${name}/${jn}: hips translation`);
      } else {
        assertEquals(tr.translations, undefined, `${name}/${jn}: only hips carries translation`);
      }
    }
  }
});

test('Walk_Loop: output rotations are hemisphere-continuous and unit length', async () => {
  const f = await fx();
  for (const [name, rest] of f.targets) {
    const res = retargetClip(f.walk, f.ualRest, rest, UAL_HUMANOID);
    for (const [jn, tr] of res.clip.tracks) {
      const r = tr.rotations!;
      for (let i = 0; i < tr.times.length; i++) {
        assertAlmostEquals(
          Math.hypot(r[i * 4], r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3]),
          1,
          1e-3,
          `${name}/${jn}[${i}]: unit`,
        );
        if (i === 0) continue;
        let dot = 0;
        for (let c = 0; c < 4; c++) dot += r[i * 4 + c] * r[(i - 1) * 4 + c];
        assert(dot >= 0, `${name}/${jn}[${i}]: adjacent-frame dot ${dot} < 0`);
      }
    }
  }
});

/** Canonical plain-data projection for deep equality. */
function canon(res: RetargetResult) {
  return {
    id: res.clip.id,
    duration: res.clip.duration,
    tracks: [...res.clip.tracks.entries()].map(([n, tr]) => ({
      n,
      times: Array.from(tr.times),
      rotations: tr.rotations ? Array.from(tr.rotations) : null,
      translations: tr.translations ? Array.from(tr.translations) : null,
      scales: tr.scales ? Array.from(tr.scales) : null,
      interpolation: tr.interpolation,
    })),
    report: res.report,
    stats: res.stats,
  };
}

test('retargetClip is deterministic: identical inputs give deep-equal results', async () => {
  const f = await fx();
  const [, rest] = f.targets[0];
  const a = retargetClip(f.walk, f.ualRest, rest, UAL_HUMANOID);
  const b = retargetClip(f.walk, f.ualRest, rest, UAL_HUMANOID);
  assertEquals(canon(a), canon(b));
});

test('A_TPose null transfer: every target stays at rest (identity-ish deltas, ~zero correction)', async () => {
  const f = await fx();
  for (const [name, rest] of f.targets) {
    const res = retargetClip(f.tpose, f.ualRest, rest, UAL_HUMANOID);
    const tsk = fkRest(rest);
    for (const [jn, tr] of res.clip.tracks) {
      const restRot = tsk.local.get(jn)!.rot;
      for (let i = 0; i < tr.times.length; i++) {
        const q: Quat = [
          tr.rotations![i * 4],
          tr.rotations![i * 4 + 1],
          tr.rotations![i * 4 + 2],
          tr.rotations![i * 4 + 3],
        ];
        assert(qAngle(q, restRot) < 1e-3, `${name}/${jn}[${i}]: rest orientation`);
      }
    }
    const pelvis = res.clip.tracks.get('pelvis')!;
    const restPos = tsk.local.get('pelvis')!.pos;
    for (let i = 0; i < pelvis.times.length; i++) {
      const d = Math.hypot(
        pelvis.translations![i * 3] - restPos[0],
        pelvis.translations![i * 3 + 1] - restPos[1],
        pelvis.translations![i * 3 + 2] - restPos[2],
      );
      assert(d < 1e-6, `${name}: pelvis stays at rest (${d})`);
    }
    assert(res.stats.footContactMaxErrM < 1e-6, `${name}: nothing to correct`);
  }
});

test('degenerate target hips rest height fails loud (review F6)', async () => {
  const f = await fx();
  // a target whose pelvis rests at Y=0: hipScale would silently zero root motion
  const flat: SkeletonRest = {
    parents: new Map([['pelvis', '']]),
    locals: new Map([[
      'pelvis',
      Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
    ]]),
  };
  let threw = false;
  try {
    retargetClip(f.walk, f.ualRest, flat, UAL_HUMANOID);
  } catch (err) {
    threw = true;
    assert(String(err).includes('target hips rest height'), `actionable: ${err}`);
  }
  assert(threw, 'flat target must be rejected, not silently mirrored/zeroed');
});

test('non-unit rest scale fails loud, naming the joint (review F7)', async () => {
  const f = await fx();
  const [, normal] = f.targets[0];
  // clone the normal body and bake a 2x scale into one joint's rest local —
  // the rest FK would silently mis-measure hip height on such a rig
  const scaled: SkeletonRest = {
    parents: new Map(normal.parents),
    locals: new Map([...normal.locals].map(([k, v]) => [k, Float32Array.from(v)])),
  };
  const m = scaled.locals.get('spine_01')!;
  for (const c of [0, 1, 2, 4, 5, 6, 8, 9, 10]) m[c] *= 2;
  let threw = false;
  try {
    retargetClip(f.walk, f.ualRest, scaled, UAL_HUMANOID);
  } catch (err) {
    threw = true;
    assert(String(err).includes('spine_01'), `names the joint: ${err}`);
    assert(String(err).includes('rest scale'), `names the cause: ${err}`);
  }
  assert(threw, 'non-unit rest scale must be rejected, not silently mis-measured');
});

// ---------------------------------------------------------------------------
// D-040: dialect targets resolve through profile aliases
// ---------------------------------------------------------------------------

function renamed(rest: SkeletonRest, ren: Record<string, string>): SkeletonRest {
  const nn = (n: string) => ren[n] ?? n;
  const parents = new Map<string, string>();
  const locals = new Map<string, Float32Array>();
  for (const [j, p] of rest.parents) parents.set(nn(j), nn(p));
  for (const [j, m] of rest.locals) locals.set(nn(j), m);
  return { parents, locals };
}

test('anatomically contradictory joint names refuse before retargeting', async () => {
  const f = await fx();
  const normal = f.targets[0][1];
  const mislabeled = renamed(normal, { pelvis: 'thigh_r', thigh_r: 'pelvis' });
  const err = assertThrows(() => retargetClip(f.walk, f.ualRest, mislabeled, UAL_HUMANOID), Error);
  assert(err.message.includes('Rebuild the rig'), err.message);
  assert(err.message.includes('pelvis'), err.message);
});

test('D-040: a hips/head dialect target maps through aliases, keeping its own names', async () => {
  const f = await fx();
  const canonical = f.targets.find(([n]) => n === 'normal')![1];
  const dialect = renamed(canonical, { pelvis: 'hips', Head: 'head' });

  const base = retargetClip(f.walk, f.ualRest, canonical, UAL_HUMANOID);
  const res = retargetClip(f.walk, f.ualRest, dialect, UAL_HUMANOID);

  // the target's OWN names are what the output speaks - a preview glb whose
  // tracks named joints the nodes don't carry would animate nothing
  assert(res.report.mapped.includes('hips'), 'hips mapped under its dialect name');
  assert(res.report.mapped.includes('head'), 'head mapped under its dialect name');
  assert(!res.report.mapped.includes('pelvis'), 'no phantom canonical names in the output');
  assertEquals(res.report.aliases, { hips: 'pelvis', head: 'Head' });

  // the motion is the SAME motion: rotations and root translation transfer
  // exactly as they do onto the canonically-named twin
  const hipsTrack = res.clip.tracks.get('hips')!;
  const pelvisTrack = base.clip.tracks.get('pelvis')!;
  assert(hipsTrack.translations, 'root motion flowed through the alias');
  assertEquals([...hipsTrack.translations!], [...pelvisTrack.translations!]);
  assertEquals([...hipsTrack.rotations!], [...pelvisTrack.rotations!]);
  assertEquals([...res.clip.tracks.get('head')!.rotations!], [
    ...base.clip.tracks.get('Head')!.rotations!,
  ]);
  assertAlmostEquals(res.stats.hipScale, base.stats.hipScale, 1e-12);
  assertAlmostEquals(res.stats.footContactMaxErrM, base.stats.footContactMaxErrM, 1e-12);

  // and a rig missing hips under EVERY name still refuses, naming the aliases
  const noHips = renamed(canonical, { pelvis: 'sacrum' });
  const err = assertThrows(() => retargetClip(f.walk, f.ualRest, noHips, UAL_HUMANOID), Error);
  assert(err.message.includes('aliases tried'), err.message);
});
