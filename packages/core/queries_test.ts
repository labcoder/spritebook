import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { SCHEMA_VERSION } from '@spritebook/schema';
import { createWorkspace, readWorkspace, workspacePaths } from './workspace.ts';
import { commitManifest, moveManifestCursor } from './persistence.ts';
import { listWorkspaces, readBakeArtifact, readCurrentBake } from './queries.ts';
import { runCli } from '../cli/mod.ts';

Deno.test('core, CLI and artifacts follow the selected bake through undo, never directory age', async () => {
  const root = await Deno.makeTempDir();
  const workspace = `${root}/hero`;
  try {
    await createWorkspace({
      workspace,
      characterId: 'hero',
      displayName: 'Hero',
      source: { kind: 'mesh', originalFilename: 'hero.glb', sha256: 'a'.repeat(64) },
    });
    const manifestPath = workspacePaths(workspace).manifest;
    const bake = JSON.parse(
      await Deno.readTextFile(
        new URL('../schema/fixtures/valid/bake-manifest.json', import.meta.url),
      ),
    );
    Object.assign(bake, { schemaVersion: SCHEMA_VERSION, characterId: 'hero' });
    bake.inputs.characterId = 'hero';
    for (const [id, byte] of [['e41c', 1], ['f00d', 2]] as const) {
      const dir = `${workspace}/bakes/bake-${id}`;
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(`${dir}/manifest.json`, JSON.stringify({ ...bake, bakeId: id }));
      await Deno.writeFile(`${dir}/atlas-0-lit.png`, new Uint8Array([byte]));
      await Deno.writeFile(`${dir}/contact-walk_relaxed.gif`, new Uint8Array([byte]));
      await commitManifest(manifestPath, () => ({
        op: [{ op: 'add', path: '/lastBakeId', value: id }],
        label: `Select ${id}`,
      }));
    }
    await moveManifestCursor(manifestPath, 'undo');
    assertEquals((await readCurrentBake(workspace))?.manifest.bakeId, 'e41c');
    assertEquals(await readBakeArtifact(workspace, 'thumb'), 'AQ==');
    const atlas = await readBakeArtifact(workspace, 'atlas');
    assertEquals(typeof atlas === 'object' && atlas?.png, 'AQ==');
    const lines: string[] = [];
    assertEquals(
      await runCli(['workspace', '--workspace', workspace, '--bake', '--json'], {
        stdout: (line) => lines.push(line),
        stderr: (line) => {
          throw new Error(line);
        },
      }),
      0,
    );
    assertEquals(lines.length, 1, 'query is one document, not a job stream');
    assertEquals(JSON.parse(lines[0]).manifest.bakeId, 'e41c');
    await Deno.mkdir(`${root}/broken`);
    await Deno.writeTextFile(`${root}/broken/character.json`, 'broken JSON');
    const list = await listWorkspaces(root);
    assertEquals(list.length, 2);
    assertEquals(
      list.find((w) => w.dir.endsWith('hero'))?.manifest,
      await readWorkspace(workspace),
    );
    assertEquals(list.find((w) => w.dir.endsWith('broken'))?.manifest, null);
    await Deno.remove(`${workspace}/bakes/bake-e41c/manifest.json`);
    await assertRejects(() => readCurrentBake(workspace), Deno.errors.NotFound);
    await moveManifestCursor(manifestPath, 'undo');
    assertEquals(
      await readBakeArtifact(workspace, 'thumb'),
      null,
      'no selection cannot choose another existing bake',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
