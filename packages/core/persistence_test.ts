import { assert, assertEquals } from 'jsr:@std/assert@1';
import { appendGenerationResult } from './receipts.ts';
import { createWorkspace, readWorkspace, workspacePaths } from './workspace.ts';
import { moveManifestCursor } from './persistence.ts';

async function append(workspace: string, id: string) {
  await appendGenerationResult(workspace, {
    id,
    backend: { modelId: 'fixture-gen', version: '1' },
    params: {},
    seed: 7,
    startedAt: '2026-10-19T00:00:00Z',
    wallTimeS: 0,
    output: { gltfSha256: 'a'.repeat(64), tris: 1, kind: 'mesh' },
    discarded: false,
  });
}

function child(workspace: string, mode: string) {
  return new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-read', '--allow-write', import.meta.filename!, workspace, mode],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
}

async function fixture() {
  const workspace = await Deno.makeTempDir({ prefix: 'sb-state-' });
  await createWorkspace({
    workspace,
    characterId: 'state',
    displayName: 'State',
    source: { kind: 'mesh', originalFilename: 'test.glb', sha256: 'a'.repeat(64) },
  });
  return workspace;
}

Deno.test('independent writers keep both acknowledged histories, including their inverses', async () => {
  const workspace = await fixture();
  try {
    const results = await Promise.all([child(workspace, 'writer-a'), child(workspace, 'writer-b')]);
    for (const result of results) {
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    }
    const manifest = workspacePaths(workspace).manifest;
    const ids = (await readWorkspace(workspace)).generation.results.map((r) => r.id);
    assertEquals(ids.length, 10);
    assertEquals(new Set(ids).size, 10);
    for (let i = 0; i < 10; i++) await moveManifestCursor(manifest, 'undo');
    assertEquals((await readWorkspace(workspace)).generation.results, []);
    for (let i = 0; i < 10; i++) await moveManifestCursor(manifest, 'redo');
    assertEquals((await readWorkspace(workspace)).generation.results.map((r) => r.id), ids);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test('process death at each persistence boundary recovers one coherent state', async (t) => {
  for (
    const boundary of [
      'before-intent',
      'pending.json',
      'journal.ndjson',
      'journal.cursor',
      'character.json',
    ]
  ) {
    await t.step(boundary, async () => {
      const workspace = await fixture();
      try {
        const result = await child(workspace, boundary);
        assertEquals(result.code, 91, new TextDecoder().decode(result.stderr));
        const manifest = workspacePaths(workspace).manifest;
        const state = await readWorkspace(workspace); // also proves the dead process released its lock
        if (boundary === 'before-intent') {
          assertEquals(state.generation.results, []);
          assertEquals(await Deno.readTextFile(`${manifest}.journal.cursor`), '0');
        } else {
          assertEquals(state.generation.results.map((r) => r.id), ['new']);
          await moveManifestCursor(manifest, 'undo');
          assertEquals((await readWorkspace(workspace)).generation.results, []);
          await moveManifestCursor(manifest, 'redo');
          assertEquals((await readWorkspace(workspace)).generation.results.map((r) => r.id), [
            'new',
          ]);
        }
        assert(
          !(await Array.fromAsync(Deno.readDir(workspace))).some((e) =>
            e.name.endsWith('.pending.json')
          ),
        );
      } finally {
        await Deno.remove(workspace, { recursive: true });
      }
    });
  }
});

if (import.meta.main) {
  const [workspace, mode] = Deno.args;
  if (mode.startsWith('writer-')) {
    for (let i = 0; i < 5; i++) await append(workspace, `${mode}-${i}`);
  } else {
    const rename = Deno.rename;
    Deno.rename = async (from, to) => {
      if (mode === 'before-intent' && String(to).endsWith('.pending.json')) Deno.exit(91);
      await rename(from, to);
      if (String(to).endsWith(mode)) Deno.exit(91);
    };
    await append(workspace, 'new');
  }
}
