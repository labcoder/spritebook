/**
 * The sentence a refused `--adjust` produces, against the REAL catalog.
 *
 * Pinned from a field report, verbatim:
 *
 *   gen --adjust decimationTarget=800000,resolution=1024,steps=25
 *   -> backend-failed: params rejected by "trellis2" schema:
 *      params must NOT have additional properties
 *
 * Two knobs were fine, one belonged to the other operation, and the message
 * named none of them — after a sidecar process had already been spawned.
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { loadCatalog } from '@spritebook/registry';
import type { ModelVersion } from '@spritebook/schema';
import { checkOpParams } from './opparams.ts';

async function trellis2(): Promise<ModelVersion> {
  const cat = await loadCatalog();
  return cat.models.find((m) => m.id === 'trellis2-4b')!.versions[0];
}

const failed = (r: ReturnType<typeof checkOpParams>): string => {
  assert(!r.ok, 'expected a refusal');
  return r.ok ? '' : r.message;
};

Deno.test('a cross-operation knob is named, and told whose it is', async () => {
  const msg = failed(checkOpParams('trellis2-4b', await trellis2(), 'gen3d', { resolution: 1024 }));
  assertStringIncludes(msg, '"resolution" is a retexture-only knob');
  assertStringIncludes(msg, 'gen3d accepts: candidates, decimationTarget');
  assert(!msg.includes('additional properties'), `the vague sentence is gone: ${msg}`);
});

Deno.test('the field report: the two good knobs are not blamed for the bad one', async () => {
  const msg = failed(checkOpParams('trellis2-4b', await trellis2(), 'gen3d', {
    decimationTarget: 800_000,
    resolution: 1024,
    steps: 25,
  }));
  assertStringIncludes(msg, '"resolution" is a retexture-only knob');
  // decimationTarget and steps appear ONLY in the roster of what gen3d takes,
  // never as a complaint
  assert(!/decimationTarget[^:]*(rejected|unknown|invalid)/.test(msg), msg);
  assertEquals(msg.match(/is a .*-only knob/g)?.length, 1, `exactly one knob is at fault: ${msg}`);
});

Deno.test('a knob of neither operation is a plain unknown, with the roster', async () => {
  const msg = failed(checkOpParams('trellis2-4b', await trellis2(), 'gen3d', { stpes: 25 }));
  assertStringIncludes(msg, 'unknown param(s) stpes');
  assertStringIncludes(msg, 'gen3d accepts: ');
  assert(!msg.includes('-only knob'), `a typo belongs to no operation: ${msg}`);
});

Deno.test('the narrowing cuts both ways: gen knobs are refused by retexture', async () => {
  const v = await trellis2();
  for (const key of ['steps', 'decimationTarget', 'candidates', 'pipelineType']) {
    const msg = failed(checkOpParams('trellis2-4b', v, 'retexture', { [key]: 1 }));
    assertStringIncludes(msg, `"${key}" is a gen3d-only knob`);
    assertStringIncludes(msg, 'retexture accepts: ');
  }
});

Deno.test('a digit-string enum survives --adjust and reaches the backend as a string', async () => {
  // `--adjust pipelineType=1024_cascade` arrives as a string (JSON.parse fails,
  // so the CLI keeps it), but `pipelineType=1024` arrives as a NUMBER
  const check = checkOpParams('trellis2-4b', await trellis2(), 'gen3d', { pipelineType: 1024 });
  assert(check.ok, check.ok ? '' : check.message);
  if (check.ok) assertEquals(check.params.pipelineType, '1024');
});

Deno.test('a value out of range still fails, with the bound', async () => {
  const msg = failed(checkOpParams('trellis2-4b', await trellis2(), 'gen3d', { steps: 500 }));
  assertStringIncludes(msg, 'params/steps must be <= 50');
});

Deno.test('a value outside an enum is told what the enum holds', async () => {
  const msg = failed(checkOpParams('trellis2-4b', await trellis2(), 'gen3d', { textureSize: 999 }));
  assertStringIncludes(msg, 'params/textureSize must be one of 1024, 2048, 4096');
});

Deno.test('valid knobs pass through untouched, defaults included', async () => {
  const v = await trellis2();
  const check = checkOpParams('trellis2-4b', v, 'gen3d', {
    seed: 7,
    steps: 25,
    decimationTarget: 800_000,
    lowVram: true,
  });
  assert(check.ok, check.ok ? '' : check.message);
  if (check.ok) assertEquals(check.params.decimationTarget, 800_000);
});

Deno.test('a backend with nothing to disambiguate keeps every knob', async () => {
  const cat = await loadCatalog();
  const unirig = cat.models.find((m) => m.id === 'unirig')!.versions[0];
  const msg = failed(checkOpParams('unirig', unirig, 'rig', { nonsense: 1 }));
  assertStringIncludes(msg, 'unknown param(s) nonsense');
  assert(!msg.includes('-only knob'), msg);
});
