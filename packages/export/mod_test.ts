/**
 * The export seam over the committed fixture bake: all four targets project
 * cleanly (files + JobEvents only), and a double export is byte-identical
 * across every written file — the unchanged-bake byte-stability acceptance at
 * the seam level (each exporter also proves it individually).
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { JobEventSchema } from '@spritebook/schema';
import type { ExportTargetId } from '@spritebook/schema';
import { runExportJob } from './mod.ts';

const BAKE = new URL('./fixtures/bake-aabbccdd', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const TARGETS: ExportTargetId[] = ['godot', 'aseprite', 'texturepacker', 'strips'];

async function runAll(outDir: string) {
  const events = [];
  for await (
    const e of runExportJob({ jobId: 'ex-1', bakeDir: BAKE, outDir, targets: TARGETS, fps: 8 })
  ) events.push(e);
  return events;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) out.push(...await walkFiles(p));
    else out.push(p);
  }
  return out.sort();
}

Deno.test('export seam: four targets, valid events, expected key files', async () => {
  const out = await Deno.makeTempDir();
  try {
    const events = await runAll(out);
    for (const e of events) {
      JobEventSchema.parse(e);
      assertEquals(e.jobId, 'ex-1');
    }
    assert(events.some((e) => e.t === 'done'), 'runs to done');
    const artifacts = events.filter((e) => e.t === 'artifact');
    assertEquals(artifacts.length, 4, 'one artifact per target');

    for (
      const key of [
        'godot/fixture-char.tres',
        'aseprite/fixture-char.ase.json',
        'texturepacker/fixture-char.tp.json',
        'strips/fixture-char-strips.json',
        'strips/fixture-char-idle-d00-strip.png',
      ]
    ) {
      await Deno.stat(`${out}/${key}`); // throws if the projection is missing
    }
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('export seam: double export is byte-identical across every file', async () => {
  const a = await Deno.makeTempDir(), b = await Deno.makeTempDir();
  try {
    await runAll(a);
    await runAll(b);
    const fa = await walkFiles(a), fb = await walkFiles(b);
    assertEquals(fa.map((p) => p.slice(a.length)), fb.map((p) => p.slice(b.length)), 'same tree');
    // godot(.tres + lit png) + aseprite(json + png) + tp(json + png) + strips(2 strips + meta)
    assertEquals(fa.length, 9, 'the fixture projects to exactly 9 files');
    for (let i = 0; i < fa.length; i++) {
      assertEquals(await Deno.readFile(fa[i]), await Deno.readFile(fb[i]), `differs: ${fa[i]}`);
    }
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test('export seam: empty targets is an error event, not a throw', async () => {
  const out = await Deno.makeTempDir();
  try {
    const events = [];
    for await (
      const e of runExportJob({ jobId: 'ex-2', bakeDir: BAKE, outDir: out, targets: [] })
    ) events.push(e);
    const err = events.at(-1)!;
    assert(err.t === 'error' && err.code === 'export-failed');
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});
