/**
 * Tier-2 real-engine smoke (docs/export-validation.md): imports the exported
 * SpriteFrames into an actual Godot 4 and asserts the animations load. GATED —
 * per maintainer decision real-engine validation runs at the very end of the
 * project, so this is `ignored` unless GODOT4_BIN points at a Godot 4.x binary
 * (never auto-downloaded in CI). Until first exercised against a real binary,
 * treat failures here as smoke-harness bugs first.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import { exportGodot } from './godot.ts';

const GODOT = Deno.env.get('GODOT4_BIN');
const BAKE = new URL('./fixtures/bake-aabbccdd', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

Deno.test({
  name: 'godot smoke: a real Godot 4 loads the exported SpriteFrames',
  ignore: !GODOT,
  fn: async () => {
    const project = await Deno.makeTempDir({ prefix: 'sb-godot-smoke-' });
    try {
      const manifest = parseWith(
        BakeManifestSchema,
        JSON.parse(await Deno.readTextFile(`${BAKE}/manifest.json`)),
        'fixture BakeManifest',
      );
      await exportGodot(manifest, BAKE, project, { fps: 8 });
      await Deno.writeTextFile(
        `${project}/project.godot`,
        '[application]\nconfig/name="sb-smoke"\nconfig/features=PackedStringArray("4.2")\n',
      );
      await Deno.writeTextFile(
        `${project}/smoke.gd`,
        [
          'extends SceneTree',
          'func _init():',
          '\tvar frames: SpriteFrames = load("res://fixture-char.tres")',
          '\tassert(frames != null, "SpriteFrames failed to load")',
          '\tvar names := frames.get_animation_names()',
          '\tassert(names.size() == 2, "expected 2 animations, got %d" % names.size())',
          '\tassert(frames.get_frame_count("idle_d00") == 2, "idle_d00 frame count")',
          '\tassert(frames.get_frame_count("idle_d01") == 2, "idle_d01 frame count")',
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
          '\tvar tex: Texture2D = frames.get_frame_texture("idle_d00", 0)',
          '\tvar sz: Vector2 = tex.get_size()',
          '\tassert(sz == Vector2(16, 28), "anchor box: expected (16, 28), got %s" % sz)',
          '\tprint("SMOKE_OK")',
          '\tquit(0)',
          '',
        ].join('\n'),
      );

      // import pass (builds .godot/), then the assertion script
      const importRun = new Deno.Command(GODOT!, {
        args: ['--headless', '--path', project, '--import'],
        stdout: 'piped',
        stderr: 'piped',
      });
      const imp = await importRun.output();
      assert(imp.success, `godot --import failed: ${new TextDecoder().decode(imp.stderr)}`);

      const scriptRun = new Deno.Command(GODOT!, {
        args: ['--headless', '--path', project, '--script', 'res://smoke.gd'],
        stdout: 'piped',
        stderr: 'piped',
      });
      const run = await scriptRun.output();
      const stdout = new TextDecoder().decode(run.stdout);
      assertEquals(
        run.success,
        true,
        `smoke script failed: ${new TextDecoder().decode(run.stderr)}`,
      );
      assert(stdout.includes('SMOKE_OK'), `script did not reach SMOKE_OK:\n${stdout}`);
    } finally {
      await Deno.remove(project, { recursive: true }).catch(() => {});
    }
  },
});
