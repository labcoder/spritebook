/**
 * Godot exporter tests against the checked-in fixture bake. parseTres +
 * validateTres are the everywhere-test for Godot correctness (real-engine
 * import smoke deferred to end-of-project); the doctrine test proves the
 * projection is byte-stable.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1';
import { type BakeManifest, BakeManifestSchema, parseWith } from '@spritebook/schema';
import { DEFAULT_FPS } from '../pack/contracts.ts';
import { exportGodot } from './godot.ts';
import { parseTres, TresParseError, validateTres } from './tres-parse.ts';

const win = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FIXTURE_DIR = win(new URL('fixtures/bake-aabbccdd', import.meta.url));

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

async function fixtureManifest(): Promise<BakeManifest> {
  const raw = JSON.parse(await Deno.readTextFile(`${FIXTURE_DIR}/manifest.json`));
  return parseWith(BakeManifestSchema, raw, 'fixture BakeManifest');
}

/** The exact bytes godot.ts must emit for the fixture (LF, trailing newline). */
const EXPECTED_TRES = [
  '[gd_resource type="SpriteFrames" load_steps=6 format=3]',
  '',
  '[ext_resource type="Texture2D" path="atlas_lit_0.png" id="1"]',
  '',
  '[sub_resource type="AtlasTexture" id="AtlasTexture_1"]',
  'atlas = ExtResource("1")',
  'region = Rect2(0, 0, 16, 16)',
  '',
  '[sub_resource type="AtlasTexture" id="AtlasTexture_2"]',
  'atlas = ExtResource("1")',
  'region = Rect2(16, 0, 16, 16)',
  '',
  '[sub_resource type="AtlasTexture" id="AtlasTexture_3"]',
  'atlas = ExtResource("1")',
  'region = Rect2(32, 0, 16, 16)',
  '',
  '[sub_resource type="AtlasTexture" id="AtlasTexture_4"]',
  'atlas = ExtResource("1")',
  'region = Rect2(48, 0, 16, 16)',
  '',
  '[resource]',
  'animations = [{',
  '"frames": [{',
  '"duration": 1.0,',
  '"texture": SubResource("AtlasTexture_1")',
  '}, {',
  '"duration": 1.0,',
  '"texture": SubResource("AtlasTexture_2")',
  '}],',
  '"loop": true,',
  '"name": &"idle_d00",',
  '"speed": 8.0',
  '}, {',
  '"frames": [{',
  '"duration": 1.0,',
  '"texture": SubResource("AtlasTexture_3")',
  '}, {',
  '"duration": 1.0,',
  '"texture": SubResource("AtlasTexture_4")',
  '}],',
  '"loop": true,',
  '"name": &"idle_d01",',
  '"speed": 8.0',
  '}]',
].join('\n') + '\n';

Deno.test('exportGodot: fixture projects to a parseable, manifest-valid SpriteFrames', async () => {
  const manifest = await fixtureManifest();
  const out = await Deno.makeTempDir({ prefix: 'sb-godot-' });
  try {
    const paths = await exportGodot(manifest, FIXTURE_DIR, out, { fps: DEFAULT_FPS });
    assertEquals(paths, [...paths].sort(), 'returned paths must be sorted');
    assertEquals(paths.map(baseName), ['atlas_lit_0.png', 'fixture-char.tres']);
    for (const p of paths) assert((await Deno.stat(p)).isFile, `missing written file: ${p}`);

    const parsed = parseTres(await Deno.readTextFile(`${out}/fixture-char.tres`));
    validateTres(parsed, manifest);
    assertEquals(parsed.header, { type: 'SpriteFrames', loadSteps: 6, format: 3 });
    assertEquals(parsed.extResources.map((e) => e.id), ['1']);
    assertEquals(parsed.subResources.map((s) => s.id), [
      'AtlasTexture_1',
      'AtlasTexture_2',
      'AtlasTexture_3',
      'AtlasTexture_4',
    ]);
    assertEquals(parsed.animations.map((a) => a.name), ['idle_d00', 'idle_d01']);
    assertEquals(parsed.animations.map((a) => a.speed), [DEFAULT_FPS, DEFAULT_FPS]);
    assertEquals(parsed.animations.map((a) => a.frames.length), [2, 2]);
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('exportGodot: .tres bytes match the specced Godot 4 shape exactly', async () => {
  const manifest = await fixtureManifest();
  const out = await Deno.makeTempDir({ prefix: 'sb-godot-' });
  try {
    await exportGodot(manifest, FIXTURE_DIR, out, { fps: DEFAULT_FPS });
    const text = await Deno.readTextFile(`${out}/fixture-char.tres`);
    assertEquals(text, EXPECTED_TRES);
    // spot-checks the spec calls out, independent of the golden above
    assertStringIncludes(text, '&"idle_d00"');
    assertStringIncludes(text, '&"idle_d01"');
    assertStringIncludes(text, 'Rect2(16, 0, 16, 16)');
    assertStringIncludes(text, 'load_steps=6');
    assertStringIncludes(text, '"speed": 8.0');
    assert(!text.includes('uid='), 'uid must be omitted for byte-stability');
    assert(!text.includes('\r'), 'LF line endings only');
    assert(text.endsWith('}]\n'), 'ends with the closed animations array + newline');
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('exportGodot: double export is byte-identical (byte-stability doctrine)', async () => {
  const manifest = await fixtureManifest();
  const outA = await Deno.makeTempDir({ prefix: 'sb-godot-a-' });
  const outB = await Deno.makeTempDir({ prefix: 'sb-godot-b-' });
  try {
    const a = await exportGodot(manifest, FIXTURE_DIR, outA, { fps: DEFAULT_FPS });
    const b = await exportGodot(manifest, FIXTURE_DIR, outB, { fps: DEFAULT_FPS });
    assertEquals(a.map(baseName), b.map(baseName));
    for (let i = 0; i < a.length; i++) {
      assertEquals(
        await Deno.readFile(a[i]),
        await Deno.readFile(b[i]),
        `bytes differ: ${baseName(a[i])}`,
      );
    }
  } finally {
    await Deno.remove(outA, { recursive: true });
    await Deno.remove(outB, { recursive: true });
  }
});

Deno.test('exportGodot: copies the lit page bytes verbatim', async () => {
  const manifest = await fixtureManifest();
  const out = await Deno.makeTempDir({ prefix: 'sb-godot-' });
  try {
    await exportGodot(manifest, FIXTURE_DIR, out, { fps: DEFAULT_FPS });
    assertEquals(
      await Deno.readFile(`${out}/atlas_lit_0.png`),
      await Deno.readFile(`${FIXTURE_DIR}/atlas_lit_0.png`),
    );
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('parseTres: corrupted output throws precise errors', async () => {
  const manifest = await fixtureManifest();
  const out = await Deno.makeTempDir({ prefix: 'sb-godot-' });
  try {
    await exportGodot(manifest, FIXTURE_DIR, out, { fps: DEFAULT_FPS });
    const text = await Deno.readTextFile(`${out}/fixture-char.tres`);
    parseTres(text); // sanity: the pristine text parses

    // one mutated char in a section header
    assertThrows(
      () => parseTres(text.replace('[sub_resource type', '[sub_resourcx type')),
      TresParseError,
    );
    assertThrows(
      () => parseTres(text.replace('[gd_resource type', '[gd_resovrce type')),
      TresParseError,
    );
    // dangling SubResource reference
    assertThrows(
      () =>
        parseTres(
          text.replace('SubResource("AtlasTexture_4")', 'SubResource("AtlasTexture_9")'),
        ),
      TresParseError,
      'unknown sub_resource',
    );
    // region number no longer finite
    assertThrows(
      () => parseTres(text.replace('Rect2(48, 0, 16, 16)', 'Rect2(4x8, 0, 16, 16)')),
      TresParseError,
      'not finite',
    );
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});
