import { runProcess } from '../../tools/testing/process.ts';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Tier-2 real-engine smoke (docs/export-validation.md): imports the exported
 * SpriteFrames into an actual Godot 4 and asserts the animations load. GATED —
 * per maintainer decision real-engine validation runs at the very end of the
 * project, so this is `ignored` unless GODOT4_BIN points at a Godot 4.x binary
 * (never auto-downloaded in CI).
 *
 * FIRST EXERCISED 2026-07-26 against Godot 4.7.1.stable (a13da4feb), on the
 * maintainer's Windows machine: green, including the anchor box. That is the
 * one claim in this repo no in-house test can make — `pivotMargin`,
 * `validateTres` and `godot_test`'s `anchorOf` share a single model of
 * `AtlasTexture.margin`, so if the model were inverted all three would agree
 * and every character would still import mis-anchored. Godot reports
 * (16.0, 28.0); the model says (16, 28).
 */
import { assert, assertEquals } from '@std/assert';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import { exportGodot } from './dist/godot.js';

const GODOT = process.env['GODOT4_BIN'];

const BAKE = new URL('./fixtures/bake-aabbccdd', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

test('godot smoke: a real Godot 4 loads the exported SpriteFrames', { skip: !GODOT }, async () => {
  const project = await fs.mkdtemp(join(tmpdir(), 'sb-godot-smoke-'));
  try {
    const manifest = parseWith(
      BakeManifestSchema,
      JSON.parse(await fs.readFile(`${BAKE}/manifest.json`, 'utf8')),
      'fixture BakeManifest',
    );
    await exportGodot(manifest, BAKE, project, { fps: 8 });
    await fs.writeFile(
      `${project}/project.godot`,
      '[application]\nconfig/name="sb-smoke"\nconfig/features=PackedStringArray("4.2")\n',
    );
    // GDScript `assert()` is NOT usable here, and finding that out cost a
    // 300-second timeout: in a debug build a failed assert breaks into the
    // remote debugger, and headless with nothing attached it simply HANGS —
    // so a regressed anchor would have hung this lane forever instead of
    // failing it. That is worse than having no test, because a timeout names
    // nothing. Every check below records a message and the script decides its
    // own exit code, so a failure is a fast non-zero with all of its reasons
    // printed at once. Verified by perturbing the expected box: 3s, and the
    // message says what Godot actually reported.
    await fs.writeFile(
      `${project}/smoke.gd`,
      [
        'extends SceneTree',
        '',
        'var failures: Array = []',
        '',
        'func check(ok: bool, msg: String) -> void:',
        '\tif not ok:',
        '\t\tfailures.append(msg)',
        '',
        'func _init():',
        '\tvar frames = load("res://fixture-char.tres")',
        '\tif frames == null:',
        '\t\tprinterr("SMOKE_FAIL: SpriteFrames failed to load at all")',
        '\t\tquit(1)',
        '\t\treturn',
        '\tvar names = frames.get_animation_names()',
        '\tcheck(names.size() == 2, "expected 2 animations, got %d" % names.size())',
        '\tcheck(frames.get_frame_count("idle_d00") == 2, "idle_d00 frame count")',
        '\tcheck(frames.get_frame_count("idle_d01") == 2, "idle_d01 frame count")',
        // THE ANCHOR CHECK. godot.ts's pivotMargin, tres-parse's
        // validateTres and godot_test's anchorOf all compute the anchor as
        // (region.size + margin.size)/2 - margin.position: three checkers,
        // ONE shared model of AtlasTexture.margin. If that model were
        // inverted every character would import mis-anchored and all of our
        // tests would still pass, because they all ask the same wrong
        // question. This asks Godot.
        //
        // The fixture records pivot (8, 14) in a 16x16 cell and the exporter
        // emits margin Rect2(0, 0, 0, 12) — verified against the real
        // exporter, not derived here — so the drawn box is (16, 28) and its
        // centre lands on the recorded pivot.
        '\tvar tex = frames.get_frame_texture("idle_d00", 0)',
        '\tvar sz = tex.get_size()',
        '\tcheck(sz == Vector2(16, 28), "anchor box: expected (16, 28), got %s" % sz)',
        '\tif failures.is_empty():',
        '\t\tprint("SMOKE_OK")',
        '\t\tquit(0)',
        '\telse:',
        '\t\tfor f in failures:',
        '\t\t\tprinterr("SMOKE_FAIL: " + f)',
        '\t\tquit(1)',
        '',
      ].join('\n'),
    );

    // Belt as well as braces: the script decides its own exit code, but a
    // headless engine can still hang for reasons we do not control, and a
    // hung child is a lane that reports nothing at all. A timeout turns that
    // into an ordinary failure with a name on it.
    const godot = async (args: string[], what: string) =>
      await runProcess(GODOT!, ['--headless', '--path', project, ...args], {
        signal: AbortSignal.timeout(90_000),
      }).catch((err) => {
        throw new Error(`godot ${what} did not finish within 90s: ${err}`);
      });

    // import pass (builds .godot/), then the assertion script
    const imp = await godot(['--import'], '--import');
    assert(imp.success, `godot --import failed: ${new TextDecoder().decode(imp.stderr)}`);

    const run = await godot(['--script', 'res://smoke.gd'], '--script');
    const stdout = new TextDecoder().decode(run.stdout);
    assertEquals(
      run.success,
      true,
      `smoke script failed: ${new TextDecoder().decode(run.stderr)}`,
    );
    assert(stdout.includes('SMOKE_OK'), `script did not reach SMOKE_OK:\n${stdout}`);
  } finally {
    await fs.rm(project, { recursive: true }).catch(() => {});
  }
});
