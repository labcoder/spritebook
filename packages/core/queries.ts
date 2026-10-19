import { Buffer } from 'node:buffer';
import { isAbsolute, resolve } from 'node:path';
import { BakeManifestSchema, type CharacterManifest, parseWith } from '@spritebook/schema';
import { withManifestLock } from './persistence.ts';
import { readWorkspace, workspacePaths } from './workspace.ts';

export interface WorkspaceSnapshot {
  dir: string;
  manifest: CharacterManifest | null;
  error?: string;
}

/** Malformed workspaces stay visible; pending first writes recover before projection. */
export async function listWorkspaces(root: string): Promise<WorkspaceSnapshot[]> {
  const base = resolve(root);
  const out: WorkspaceSnapshot[] = [];
  for await (const entry of Deno.readDir(base)) {
    if (!entry.isDirectory) continue;
    const dir = resolve(base, entry.name);
    const { manifest } = workspacePaths(dir);
    let exists = false;
    for (const path of [manifest, `${manifest}.pending.json`]) {
      try {
        await Deno.stat(path);
        exists = true;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
    if (!exists) continue;
    try {
      out.push({ dir, manifest: await readWorkspace(dir) });
    } catch (e) {
      out.push({ dir, manifest: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out.sort((a, b) => a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0);
}

function artifactPath(dir: string, name: string): string {
  if (
    isAbsolute(name) || /[:\0]/.test(name) || name.replaceAll('\\', '/').split('/').includes('..')
  ) {
    throw new Error(`Invalid bake artifact path "${name}"`);
  }
  return resolve(dir, name);
}

/** The manifest selection is authoritative, including after undo; never fall back to mtime. */
export async function readCurrentBake(workspace: string) {
  return await withManifestLock(workspacePaths(workspace).manifest, async () => {
    const character = await readWorkspace(workspace);
    if (!character.lastBakeId) return null;
    const dir = artifactPath(
      resolve(workspacePaths(workspace).bakesDir),
      `bake-${character.lastBakeId}`,
    );
    const manifest = parseWith(
      BakeManifestSchema,
      JSON.parse(await Deno.readTextFile(`${dir}/manifest.json`)),
      `BakeManifest at ${dir}`,
    );
    if (manifest.bakeId !== character.lastBakeId || manifest.characterId !== character.id) {
      throw new Error(`Selected bake at "${dir}" belongs to another character or bake id`);
    }
    return { dir, manifest };
  });
}

/** Read the selected artifact under the same recovery lock as its selection. */
export async function readBakeArtifact(workspace: string, kind: 'thumb' | 'atlas', pass = 'lit') {
  return await withManifestLock(workspacePaths(workspace).manifest, async () => {
    const bake = await readCurrentBake(workspace);
    if (!bake) return null;
    if (kind === 'atlas') {
      const atlas = bake.manifest.atlases.find((a) => a.pass === pass);
      if (!atlas) return null;
      const bytes = await Deno.readFile(artifactPath(bake.dir, atlas.png));
      return { manifest: bake.manifest, png: Buffer.from(bytes).toString('base64') };
    }
    const clips = [...new Set(bake.manifest.frames.map((f) => f.clipId))];
    for (const clip of clips) {
      try {
        return Buffer.from(await Deno.readFile(artifactPath(bake.dir, `contact-${clip}.gif`)))
          .toString('base64');
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
    return null;
  });
}
