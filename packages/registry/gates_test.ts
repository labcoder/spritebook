/**
 * Gate laws: license acceptance and territory declarations are enforced with
 * exact codes and actionable sentences; platform satisfiability follows the
 * cpu-runs-anywhere-with-that-OS rule; VRAM warns and NEVER blocks. Detectors
 * are exercised through injected runners — no nvidia-smi, no GPU — plus one
 * skip-graceful smoke of the real default path.
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { PlatformSchema } from '@spritebook/schema';
import {
  type CommandRunner,
  detectPlatform,
  detectVramGb,
  gateLicense,
  gatePlatform,
  gateTerritory,
  gateVram,
} from './gates.ts';
import { toyEntry, toyVersion } from './_testutil.ts';

const RAIL = toyEntry({
  license: {
    name: 'CreativeML Open RAIL-M',
    spdx: 'CreativeML-OpenRAIL-M',
    url: 'https://models.invalid/license',
    requiresAcceptance: true,
  },
});

const EXCLUDING = toyEntry({
  license: {
    name: 'Toy Restricted License',
    requiresAcceptance: false,
    excludedTerritories: ['AA', 'ZZ'],
  },
});

Deno.test('gateLicense: acceptance-required licenses block until --accept-license', () => {
  const blocked = gateLicense(RAIL, { acceptLicense: false });
  assert(!blocked.ok);
  assertEquals(blocked.code, 'license-acceptance-required');
  assertStringIncludes(blocked.message, 'CreativeML Open RAIL-M');
  assertStringIncludes(blocked.message, 'CreativeML-OpenRAIL-M');
  assertStringIncludes(blocked.message, 'https://models.invalid/license');
  assertStringIncludes(blocked.message, '--accept-license');

  assertEquals(gateLicense(RAIL, { acceptLicense: true }), { ok: true });
  assertEquals(gateLicense(toyEntry(), { acceptLicense: false }), { ok: true });
});

Deno.test('gateTerritory: the full declaration matrix (D-027)', () => {
  // no exclusions: fine with or without a declaration
  assertEquals(gateTerritory(toyEntry(), {}), { ok: true });
  assertEquals(gateTerritory(toyEntry(), { territory: 'US' }), { ok: true });

  // exclusions + no declaration -> must declare
  const undeclared = gateTerritory(EXCLUDING, {});
  assert(!undeclared.ok);
  assertEquals(undeclared.code, 'territory-declaration-required');
  assertStringIncludes(undeclared.message, 'AA, ZZ');
  assertStringIncludes(undeclared.message, '--territory');

  // declared on the excluded list -> refused, naming license and list
  const excluded = gateTerritory(EXCLUDING, { territory: 'AA' });
  assert(!excluded.ok);
  assertEquals(excluded.code, 'territory-excluded');
  assertStringIncludes(excluded.message, 'Toy Restricted License');
  assertStringIncludes(excluded.message, 'AA, ZZ');

  // declared outside the list -> ok
  assertEquals(gateTerritory(EXCLUDING, { territory: 'US' }), { ok: true });

  // malformed declarations are rejected up front, exclusions or not
  for (const territory of ['usa', 'aa', 'U', 'USA']) {
    const bad = gateTerritory(toyEntry(), { territory });
    assert(!bad.ok, `"${territory}" must be invalid`);
    assertEquals(bad.code, 'territory-invalid');
  }
  const lower = gateTerritory(EXCLUDING, { territory: 'aa' });
  assert(!lower.ok);
  assertEquals(lower.code, 'territory-invalid', 'format precedes membership');
});

Deno.test('gatePlatform: cpu entries run anywhere with that OS; accelerator entries do not', () => {
  // cpu entry on a cuda machine of the same OS: satisfiable
  assertEquals(
    gatePlatform(toyVersion({ platforms: ['windows-cpu'] }), 'windows-cuda'),
    { ok: true },
  );
  assertEquals(
    gatePlatform(toyVersion({ platforms: ['macos-cpu'] }), 'macos-metal'),
    { ok: true },
  );
  // exact matches
  assertEquals(gatePlatform(toyVersion({ platforms: ['linux-cuda'] }), 'linux-cuda'), {
    ok: true,
  });
  // cuda entry on a cpu machine: refused, naming both sides
  const cudaOnCpu = gatePlatform(toyVersion({ platforms: ['windows-cuda'] }), 'windows-cpu');
  assert(!cudaOnCpu.ok);
  assertEquals(cudaOnCpu.code, 'platform-unsupported');
  // the CUDA-only stack on a Mac: the P0-T4 verdict, a message not a crash
  const mac = gatePlatform(
    toyVersion({ platforms: ['windows-cuda', 'linux-cuda'] }),
    'macos-cpu',
  );
  assert(!mac.ok);
  assertStringIncludes(mac.message, 'windows-cuda or linux-cuda');
  assertStringIncludes(mac.message, 'macos-cpu');
});

Deno.test('gateVram: advisory statuses, never a block', () => {
  assertEquals(gateVram(toyVersion(), 4), { status: 'not-required' });
  assertEquals(gateVram(toyVersion(), null), { status: 'not-required' });

  const need10 = toyVersion({ minVramGb: 10 });
  assertEquals(gateVram(need10, 24), { status: 'ok' });

  const unknown = gateVram(need10, null);
  assert(unknown.status === 'unknown');
  assertStringIncludes(unknown.warn, '10');

  const below = gateVram(need10, 8);
  assert(below.status === 'below-min');
  assertStringIncludes(below.warn, '10');
  assertStringIncludes(below.warn, '8');
});

function fakeRun(res: { ok: boolean; stdout: string }, calls: string[][] = []): CommandRunner {
  return (cmd) => {
    calls.push(cmd);
    return Promise.resolve(res);
  };
}

Deno.test('detectPlatform: os + probe matrix through injected runners', async () => {
  const gpuList = { ok: true, stdout: 'GPU 0: NVIDIA GeForce RTX 3090 (UUID: GPU-x)\n' };
  const calls: string[][] = [];
  assertEquals(await detectPlatform(fakeRun(gpuList, calls), 'windows'), 'windows-cuda');
  assertEquals(calls, [['nvidia-smi', '-L']]);
  assertEquals(await detectPlatform(fakeRun({ ok: false, stdout: '' }), 'windows'), 'windows-cpu');
  assertEquals(await detectPlatform(fakeRun(gpuList), 'linux'), 'linux-cuda');
  assertEquals(await detectPlatform(fakeRun({ ok: true, stdout: '' }), 'linux'), 'linux-cpu');
  // darwin never probes: Apple Silicon assumption -> macos-metal
  const darwinCalls: string[][] = [];
  assertEquals(await detectPlatform(fakeRun(gpuList, darwinCalls), 'darwin'), 'macos-metal');
  assertEquals(darwinCalls, []);
});

Deno.test('detectVramGb: MiB -> GiB (1 decimal), first GPU, failures -> null', async () => {
  assertEquals(await detectVramGb(fakeRun({ ok: true, stdout: '24576\n' })), 24);
  assertEquals(await detectVramGb(fakeRun({ ok: true, stdout: '11178\n' })), 10.9);
  assertEquals(await detectVramGb(fakeRun({ ok: true, stdout: '24576\n12288\n' })), 24);
  assertEquals(await detectVramGb(fakeRun({ ok: false, stdout: '' })), null);
  assertEquals(await detectVramGb(fakeRun({ ok: true, stdout: '' })), null);
  assertEquals(await detectVramGb(fakeRun({ ok: true, stdout: 'N/A\n' })), null);
  assertEquals(await detectVramGb(fakeRun({ ok: true, stdout: '-5\n' })), null);
});

Deno.test('default detectors: skip-graceful smoke (no GPU required, no GPU asserted)', async () => {
  // the default runner treats ANY spawn failure as "probe says no", so this
  // passes identically on dev boxes with a 3090 and on GPU-less CI
  PlatformSchema.parse(await detectPlatform());
  const vram = await detectVramGb();
  assert(vram === null || vram > 0);
});
