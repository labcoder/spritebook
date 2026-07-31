/**
 * Install/verify/rm end-to-end against fixture bytes: no network (the fetcher
 * copies from a temp source dir), no GPU (detection injected), temp dirs
 * everywhere. collect() validates every event against JobEventSchema as it
 * streams, so a malformed event fails the suite wherever it appears.
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import type { Platform } from '@spritebook/schema';
import { canonicalJson, InstallReceiptSchema, parseWith } from '@spritebook/schema';
import { listInstalled, resolveInstalled } from './installed.ts';
import { hashFile } from './hash.ts';
import {
  type Fetcher,
  type InstallJobOpts,
  runInstallJob,
  runListQuery,
  runRmJob,
  runVerifyJob,
} from './install.ts';
import {
  collect,
  type InstallRig,
  installRig,
  ofType,
  sha256Hex,
  TOY_A,
  TOY_B,
  toyCatalog,
  URL_A,
} from './_testutil.ts';

const DETECTED = { platform: 'windows-cuda' as Platform, vramGb: 24 };

function install(rig: InstallRig, over: Partial<InstallJobOpts> = {}) {
  return runInstallJob({
    jobId: 'job-install',
    catalog: rig.catalog,
    root: rig.root,
    modelId: 'toy-rig',
    version: '1.0',
    fetcher: rig.fetcher,
    detected: DETECTED,
    ...over,
  });
}

Deno.test('install: happy path - verified files land, canonical receipt, events in order', async () => {
  const rig = await installRig();
  try {
    const events = await collect(install(rig));
    assertEquals(
      events.map((e) => e.t),
      ['queued', 'started', 'progress', 'progress', 'artifact', 'done'],
    );
    assertEquals(
      ofType(events, 'progress').map((p) => [p.step, p.done, p.total]),
      [['download', 1, 2], ['download', 2, 2]],
    );
    const [art] = ofType(events, 'artifact');
    assertEquals(art.kind, 'install-receipt');
    assertEquals(art.path, `${rig.root}/toy-rig/1.0/receipt.json`);

    // files land at their declared relative paths, byte-identical to fixtures
    assertEquals(await Deno.readFile(`${rig.root}/toy-rig/1.0/model.ckpt`), TOY_A);
    assertEquals(
      await hashFile(`${rig.root}/toy-rig/1.0/cfg/config.yaml`),
      await sha256Hex(TOY_B),
      'streaming hashFile agrees with the test-side WebCrypto digest',
    );

    // the receipt is schema-valid canonical bytes recording what the gates saw
    const text = await Deno.readTextFile(art.path);
    const receipt = parseWith(InstallReceiptSchema, JSON.parse(text), 'installed receipt');
    assertEquals(text, canonicalJson(receipt), 'receipt bytes are canonicalJson');
    assertEquals(receipt.modelId, 'toy-rig');
    assertEquals(receipt.platform, 'windows-cuda', 'cpu entry installs on a cuda machine');
    assertEquals(receipt.licenseAccepted, null, 'no acceptance required -> null');
    assertEquals(receipt.vram, { detectedGb: 24, status: 'not-required' });
    assertEquals(receipt.files.map((f) => f.path), ['model.ckpt', 'cfg/config.yaml']);

    // the installed layer and the list projection both see it
    assertEquals(
      (await listInstalled(rig.root)).map((x) => `${x.id}@${x.version}`),
      ['toy-rig@1.0'],
    );
    const [listed] = await runListQuery({ catalog: rig.catalog, root: rig.root });
    assertEquals(listed.id, 'toy-rig');
    assertEquals(listed.versions, [{
      version: '1.0',
      diskBytes: TOY_A.byteLength + TOY_B.byteLength,
      platforms: ['windows-cpu', 'linux-cpu', 'macos-cpu'],
      installed: true,
      // the D-009 form contract rides the list row (P4-T2)
      paramsSchema: {},
      defaults: {},
    }]);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test('install: a tampered download is refused - staging swept, nothing lands', async () => {
  const rig = await installRig();
  try {
    const tampered: Fetcher = async (url, dest) => {
      await rig.fetcher(url, dest);
      if (url === URL_A) {
        const bytes = await Deno.readFile(dest);
        bytes[0] ^= 0xff; // same length, different content
        await Deno.writeFile(dest, bytes);
      }
    };
    const events = await collect(install(rig, { fetcher: tampered }));
    const err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'hash-mismatch');
    assertEquals(err.retryable, false);
    assertStringIncludes(err.message, 'model.ckpt');
    assertStringIncludes(err.message, await sha256Hex(TOY_A), 'names the pinned hash');
    assertStringIncludes(err.message, 'refusing to install');
    assert(!events.some((e) => e.t === 'done'), 'no done after refusal');

    assertEquals(await Array.fromAsync(Deno.readDir(rig.root)), [], 'staging gone, no model dir');
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test('install: a byte-count mismatch is refused the same way', async () => {
  const rig = await installRig();
  try {
    const entry = rig.catalog.models[0];
    const v = entry.versions[0];
    const catalog = toyCatalog({
      ...entry,
      versions: [{
        ...v,
        files: v.files.map((f) => f.path === 'model.ckpt' ? { ...f, bytes: f.bytes + 1 } : f),
      }],
    });
    const events = await collect(install(rig, { catalog }));
    const err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'hash-mismatch');
    assertStringIncludes(err.message, 'bytes');
    assertEquals(await Array.fromAsync(Deno.readDir(rig.root)), []);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test('install: no silent overwrite - a second install errors toward models rm', async () => {
  const rig = await installRig();
  try {
    assertEquals((await collect(install(rig))).at(-1)!.t, 'done');
    const events = await collect(install(rig));
    const err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'already-installed');
    assertStringIncludes(err.message, 'models rm');
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test('install: unknown model and unknown version list what IS available', async () => {
  const rig = await installRig();
  try {
    let events = await collect(install(rig, { modelId: 'ghost' }));
    let err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'unknown-model');
    assertStringIncludes(err.message, 'toy-rig', 'lists available ids');

    events = await collect(install(rig, { version: '9.9' }));
    err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'unknown-version');
    assertStringIncludes(err.message, '1.0', 'lists available versions');
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test('install: license gate blocks BEFORE any disk writes; acceptance is recorded', async () => {
  const rig = await installRig({
    license: {
      name: 'Toy RAIL',
      spdx: 'Toy-RAIL-1.0',
      requiresAcceptance: true,
    },
  });
  try {
    const events = await collect(install(rig));
    const err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'license-acceptance-required');
    assertStringIncludes(err.message, '--accept-license');
    assertEquals(await Deno.stat(rig.root).catch(() => null), null, 'gates precede disk writes');

    assertEquals((await collect(install(rig, { acceptLicense: true }))).at(-1)!.t, 'done');
    const { receipt } = (await resolveInstalled(rig.root, 'toy-rig'))!;
    assertEquals(receipt.licenseAccepted?.name, 'Toy RAIL');
    assertEquals(receipt.licenseAccepted?.spdx, 'Toy-RAIL-1.0');
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test('install: territory gate end-to-end (declaration required, excluded, recorded)', async () => {
  const rig = await installRig({
    license: {
      name: 'Toy Restricted License',
      requiresAcceptance: false,
      excludedTerritories: ['AA', 'ZZ'],
    },
  });
  try {
    let events = await collect(install(rig));
    let err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'territory-declaration-required');

    events = await collect(install(rig, { territory: 'AA' }));
    err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'territory-excluded');
    assertStringIncludes(err.message, 'AA, ZZ');

    assertEquals((await collect(install(rig, { territory: 'US' }))).at(-1)!.t, 'done');
    const { receipt } = (await resolveInstalled(rig.root, 'toy-rig'))!;
    assertEquals(receipt.territoryDeclared, 'US', 'self-declaration recorded (D-027)');
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test('install: platform gate refuses a cuda-only entry on a cpu machine, naming both', async () => {
  const rig = await installRig({}, { platforms: ['windows-cuda', 'linux-cuda'] });
  try {
    const events = await collect(
      install(rig, { detected: { platform: 'macos-cpu', vramGb: null } }),
    );
    const err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'platform-unsupported');
    assertStringIncludes(err.message, 'windows-cuda or linux-cuda');
    assertStringIncludes(err.message, 'macos-cpu');
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test('install: VRAM warns (below-min and unknown) but NEVER blocks', async () => {
  const below = await installRig({}, { minVramGb: 10 });
  try {
    const events = await collect(
      install(below, { detected: { platform: 'windows-cuda', vramGb: 8 } }),
    );
    const [warn] = ofType(events, 'warn');
    assertEquals(warn.code, 'vram-below-min');
    assertStringIncludes(warn.message, '10');
    assertStringIncludes(warn.message, '8');
    assertEquals(events.at(-1)!.t, 'done', 'advisory only - install completes');
    const { receipt } = (await resolveInstalled(below.root, 'toy-rig'))!;
    assertEquals(receipt.vram, { minGb: 10, detectedGb: 8, status: 'below-min' });
  } finally {
    await Deno.remove(below.tmp, { recursive: true });
  }

  const unknown = await installRig({}, { minVramGb: 10 });
  try {
    const events = await collect(
      install(unknown, { detected: { platform: 'windows-cuda', vramGb: null } }),
    );
    assertEquals(ofType(events, 'warn')[0].code, 'vram-unknown');
    assertEquals(events.at(-1)!.t, 'done');
    const { receipt } = (await resolveInstalled(unknown.root, 'toy-rig'))!;
    assertEquals(receipt.vram, { minGb: 10, status: 'unknown' }, 'no detectedGb when unknown');
  } finally {
    await Deno.remove(unknown.tmp, { recursive: true });
  }
});

Deno.test('install: omitted version resolves to the HIGHEST catalog version (numeric-aware)', async () => {
  const rig = await installRig();
  try {
    const entry = rig.catalog.models[0];
    const v = entry.versions[0];
    const catalog = toyCatalog({
      ...entry,
      versions: [{ ...v, version: '1.2' }, { ...v, version: '1.10' }],
    });
    const events = await collect(install(rig, { catalog, version: undefined }));
    assertEquals(events.at(-1)!.t, 'done');
    assertEquals(
      (await listInstalled(rig.root)).map((x) => x.version),
      ['1.10'],
      '1.10 beats 1.2 numerically',
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test('verify: intact passes; corruption, catalog drift, and no-receipt fail loud', async () => {
  const rig = await installRig();
  try {
    await collect(install(rig));
    const opts = {
      jobId: 'job-verify',
      catalog: rig.catalog,
      root: rig.root,
      modelId: 'toy-rig',
    };

    let events = await collect(runVerifyJob(opts));
    assertEquals(events.map((e) => e.t), ['queued', 'started', 'progress', 'progress', 'done']);
    assertEquals(
      ofType(events, 'progress').map((p) => [p.step, p.done, p.total]),
      [['verify', 1, 2], ['verify', 2, 2]],
    );

    // flip one byte post-install -> named file, both hashes
    const target = `${rig.root}/toy-rig/1.0/model.ckpt`;
    const bytes = await Deno.readFile(target);
    bytes[3] ^= 0x01;
    await Deno.writeFile(target, bytes);
    events = await collect(runVerifyJob(opts));
    let err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'verify-failed');
    assertStringIncludes(err.message, 'model.ckpt');
    assertStringIncludes(err.message, await sha256Hex(TOY_A), 'names the recorded hash');

    // restore the bytes, then drift the CATALOG pin: disk matches the receipt
    // but no longer matches what the catalog ships -> still a loud failure
    bytes[3] ^= 0x01;
    await Deno.writeFile(target, bytes);
    const entry = rig.catalog.models[0];
    const v = entry.versions[0];
    const drifted = toyCatalog({
      ...entry,
      versions: [{
        ...v,
        files: v.files.map((f) => f.path === 'model.ckpt' ? { ...f, sha256: 'f'.repeat(64) } : f),
      }],
    });
    events = await collect(runVerifyJob({ ...opts, catalog: drifted }));
    err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'verify-failed');
    assertStringIncludes(err.message, 'catalog');

    // no receipt -> the crash-window verdict
    await Deno.remove(`${rig.root}/toy-rig/1.0/receipt.json`);
    events = await collect(runVerifyJob(opts));
    err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'no-receipt');
    assertStringIncludes(err.message, 'models rm');
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test('rm: removes a version (sweeping the empty model dir) or the whole model', async () => {
  const rig = await installRig();
  try {
    await collect(install(rig));
    let events = await collect(
      runRmJob({ jobId: 'job-rm', root: rig.root, modelId: 'toy-rig', version: '1.0' }),
    );
    assertEquals(events.map((e) => e.t), ['queued', 'started', 'done'], 'artifact-free');
    assertEquals(
      await Deno.stat(`${rig.root}/toy-rig`).catch(() => null),
      null,
      'empty model dir swept with its last version',
    );

    events = await collect(runRmJob({ jobId: 'job-rm2', root: rig.root, modelId: 'toy-rig' }));
    const err = events.at(-1)!;
    assert(err.t === 'error');
    assertEquals(err.code, 'not-installed');
    assertStringIncludes(err.message, 'models list');

    // whole-model removal (version omitted)
    await collect(install(rig));
    events = await collect(runRmJob({ jobId: 'job-rm3', root: rig.root, modelId: 'toy-rig' }));
    assertEquals(events.at(-1)!.t, 'done');
    assertEquals(await Deno.stat(`${rig.root}/toy-rig`).catch(() => null), null);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
