/**
 * doctor is honest on BOTH kinds of machine: with an adapter it reports the
 * render signature + a passing probe and exits 0; without one it reports
 * unavailability + hints and exits 1 (never a silent green).
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { runDoctor } from './doctor.ts';
import { SPRITEBOOK_VERSION } from './version.ts';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
  };
}

Deno.test('--version prints the single-source version and exits 0', async () => {
  const { runCli } = await import('./mod.ts');
  const { out, io: cliIo } = io();
  const code = await runCli(['--version'], cliIo);
  assertEquals(code, 0);
  assertEquals(out, [`spritebook ${SPRITEBOOK_VERSION}`]);
});

Deno.test('doctor: human output matches the machine it runs on', async () => {
  const { out, io: cliIo } = io();
  const code = await runDoctor([], cliIo);
  const text = out.join('\n');
  assert(text.includes(`SpriteBook ${SPRITEBOOK_VERSION}`), 'version line');
  assert(text.includes('render pipeline spritebook-render@'), 'pipeline version line');
  if (code === 0) {
    assert(text.includes('render signature: spritebook-render@'), 'signature printed');
    assert(text.includes('render probe: OK'), 'probe passed');
  } else {
    assert(
      text.includes('adapter: NONE') || text.includes('render probe: FAILED'),
      `nonzero exit explains itself:\n${text}`,
    );
  }
});

Deno.test('doctor --json: one parseable document with the same verdict', async () => {
  const { out, io: cliIo } = io();
  const code = await runDoctor(['--json'], cliIo);
  assertEquals(out.length, 1, 'exactly one JSON line');
  const doc = JSON.parse(out[0]);
  assertEquals(doc.spritebook, SPRITEBOOK_VERSION);
  if (code === 0) {
    assertEquals(doc.available, true);
    assertEquals(doc.probe.ok, true);
    assert(/^spritebook-render@.+#[0-9a-f]{8}$/.test(doc.signature), 'composed signature shape');
  }
});
