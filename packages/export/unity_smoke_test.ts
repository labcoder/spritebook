import { runProcess } from '../../tools/testing/process.ts';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Unity smoke: a REAL Unity editor imports the exported sheet by the
 * documented procedure (docs/engines/unity-texturepacker.md) — TexturePacker
 * Importer package, JSON renamed to `.json` beside the PNG, texture set to
 * Sprite/Multiple by the importer's postprocessor.
 *
 * DOUBLY gated, because both halves are user-supplied: UNITY_BIN points at a
 * Unity editor (never auto-downloaded), and SPRITEBOOK_TP_IMPORTER points at
 * the TexturePacker Importer .unitypackage the maintainer downloaded from
 * the Asset Store once (free, but not redistributable by us). Without either,
 * the test is ignored/skipped honestly. The Godot lesson is carried over:
 * the C# method chooses its own exit code via EditorApplication.Exit, so a
 * failed import can never hang batch mode or read as a hollow green.
 *
 * What it asserts when it runs: the PNG imported as a Multiple-mode sprite
 * whose sub-sprites carry exactly the frame names the JSON promised.
 */
import { assertEquals, assertStringIncludes } from '@std/assert';
import { BakeManifestSchema, parseWith } from '@spritebook/schema';
import { exportTexturePacker } from './dist/texturepacker.js';

const UNITY = process.env['UNITY_BIN'];
const TP_PACKAGE = process.env['SPRITEBOOK_TP_IMPORTER'];


const BAKE = new URL('./fixtures/bake-aabbccdd', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

test('unity smoke: a real Unity + TexturePacker Importer slices the exported sheet', { skip: !UNITY || !TP_PACKAGE }, async () => {
    const project = await fs.mkdtemp(join(tmpdir(), 'sb-unity-smoke-'));
    try {
      const manifest = parseWith(
        BakeManifestSchema,
        JSON.parse(await fs.readFile(`${BAKE}/manifest.json`, 'utf8')),
        'fixture BakeManifest',
      );
      const assets = `${project}/Assets/Smoke`;
      await fs.mkdir(`${project}/Assets/Editor`, { recursive: true });
      await fs.mkdir(assets, { recursive: true });
      await exportTexturePacker(manifest, BAKE, assets, { fps: 8 });
      const json = JSON.parse(
        await fs.readFile(`${assets}/${manifest.characterId}.tp.json`, 'utf8'),
      ) as { frames: Record<string, unknown>; meta: { image: string } };
      // the documented step 2: rename .tp.json -> .json beside the PNG
      await fs.rename(
        `${assets}/${manifest.characterId}.tp.json`,
        `${assets}/${manifest.characterId}.json`,
      );
      const expected = Object.keys(json.frames).sort();

      await fs.writeFile(
        `${project}/Assets/Editor/Smoke.cs`,
        [
          'using UnityEditor;',
          'using UnityEngine;',
          'using System.Linq;',
          'public static class Smoke {',
          '  public static void Run() {',
          '    var png = "Assets/Smoke/' + json.meta.image + '";',
          '    AssetDatabase.ImportAsset(png, ImportAssetOptions.ForceUpdate);',
          '    var sprites = AssetDatabase.LoadAllAssetsAtPath(png).OfType<Sprite>()',
          '      .Select(s => s.name).OrderBy(n => n).ToArray();',
          `    var expected = new string[] { ${expected.map((n) => `"${n}"`).join(', ')} };`,
          '    if (!sprites.SequenceEqual(expected)) {',
          '      Debug.Log("UNITY-SMOKE-FAIL got [" + string.Join(",", sprites) + "]");',
          '      EditorApplication.Exit(1);',
          '      return;',
          '    }',
          '    Debug.Log("UNITY-SMOKE-OK sprites=" + sprites.Length);',
          '    EditorApplication.Exit(0);',
          '  }',
          '}',
        ].join('\n'),
      );

      const run = runProcess(UNITY!, [
          '-batchmode',
          '-nographics',
          '-projectPath',
          project,
          '-importPackage',
          TP_PACKAGE!,
          '-executeMethod',
          'Smoke.Run',
          '-logFile',
          `${project}/unity.log`,
        ]);
      const { code } = await run;
      const log = await fs.readFile(`${project}/unity.log`, 'utf8').catch(() => '(no log)');
      assertEquals(code, 0, `unity exited ${code}; log tail:\n${log.slice(-2000)}`);
      assertStringIncludes(log, 'UNITY-SMOKE-OK', log.slice(-2000));
    } finally {
      await fs.rm(project, { recursive: true }).catch(() => {});
    }
});
