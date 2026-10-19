import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Bytes } from './dist/cache.js';
/**
 * The roster scan (P4-T3): the cheap half of the batch story.
 *
 * Its whole job is to be trustworthy about what is under a root, because
 * everything downstream — the plan, `bake --all`, the overnight pivot —
 * inherits its census. The failures it must not have are quiet ones: a
 * directory silently skipped, a `ready` that believed a manifest over the
 * disk, or a `--changed-since` that drifted from what mtime actually says.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { CharacterId } from '@spritebook/schema';
import { canonicalJson, ROSTER_FILE, RosterManifestSchema } from '@spritebook/schema';
import { createWorkspace, workspacePaths } from './dist/workspace.js';
import { renameCharacter } from './dist/roster.js';
import { scanRoster, writeRosterManifest } from './dist/roster.js';

const NOW = () => '2026-08-01T00:00:00Z';

/** A workspace under `root`, optionally with a canonical mesh on disk. */
async function member(
  root: string,
  id: string,
  opts: { displayName?: string; mesh?: boolean } = {},
): Promise<string> {
  const dir = `${root}/${id}`;
  await createWorkspace({
    workspace: dir,
    characterId: id as CharacterId,
    displayName: opts.displayName ?? id,
    source: { kind: 'mesh', originalFilename: `${id}.glb`, sha256: 'a'.repeat(64) },
    now: NOW,
  });
  if (opts.mesh !== false) {
    const paths = workspacePaths(dir);
    await fs.mkdir(paths.canonicalDir, { recursive: true });
    await fs.writeFile(paths.canonicalModel, `canonical ${id}`);
    const doc = JSON.parse(await fs.readFile(paths.manifest, 'utf8'));
    doc.canonicalMesh = {
      gltfSha256: await sha256Bytes(new Uint8Array(await fs.readFile(paths.canonicalModel))),
      heightM: 1.8,
      texturedBy: 'backend',
      reprojected: false,
    };
    await fs.writeFile(paths.manifest, canonicalJson(doc));
  }
  return dir;
}

test('the scan finds every character and sorts them stably', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await member(root, 'trunks');
    await member(root, 'bulma');
    await member(root, 'goku');
    // a directory that is not a workspace is not an error — roots hold
    // exports, notes, and whatever else the user keeps beside their characters
    await fs.mkdir(`${root}/exports`);
    await fs.writeFile(`${root}/README.md`, 'not a character');

    const roster = await scanRoster(root, { now: NOW });
    assertEquals(roster.characters.map((c) => c.id), ['bulma', 'goku', 'trunks']);
    assertEquals(roster.unreadable, []);
    // byte-identical across scans of an unchanged root: the index is derived,
    // so a rescan that churned bytes would show as spurious VCS noise
    const again = await scanRoster(root, { now: NOW });
    assertEquals(canonicalJson(roster), canonicalJson(again));
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('`ready` asks the DISK, not the manifest', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await member(root, 'bulma');
    const noMesh = await member(root, 'goku', { mesh: false });
    void noMesh;
    // the expensive way to learn a mesh is missing is at frame 1 of an
    // overnight run, so the scan opens the file the bake would open
    await fs.rm(workspacePaths(`${root}/bulma`).canonicalModel);

    const roster = await scanRoster(root, { now: NOW });
    const by = Object.fromEntries(roster.characters.map((c) => [c.id, c]));
    assertEquals(by.bulma!.ready, false, 'the manifest claims a mesh the disk does not have');
    assertEquals(by.goku!.ready, false, 'and one that never claimed it is equally unready');
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('an unreadable manifest is REPORTED, never skipped', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await member(root, 'bulma');
    await member(root, 'broken');
    await fs.writeFile(`${root}/broken/character.json`, '{ this is not json');

    const roster = await scanRoster(root, { now: NOW });
    assertEquals(roster.characters.map((c) => c.id), ['bulma']);
    assertEquals(roster.unreadable.length, 1, 'a batch that quietly did 1 of 2 is the bug');
    assertEquals(roster.unreadable[0]!.dir, 'broken');
    assert(roster.unreadable[0]!.error.length > 0, 'and it says what went wrong');
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('--changed-since filters on the manifest mtime', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await member(root, 'bulma');
    await member(root, 'goku');
    // push goku's manifest into the past; bulma keeps "now"
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const gokuManifest = workspacePaths(`${root}/goku`).manifest;
    await fs.utimes(gokuManifest, past, past);

    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const changed = await scanRoster(root, { now: NOW, changedSince: cutoff });
    assertEquals(changed.characters.map((c) => c.id), ['bulma']);

    const all = await scanRoster(root, { now: NOW });
    assertEquals(all.characters.length, 2, 'without the filter both are present');
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('a rename MOVES a character in --changed-since and invalidates nothing', async () => {
  // The two questions the batch surface asks are deliberately different, and
  // this is where they visibly disagree: mtime says the file was touched, and
  // D-011 says a display name can never reach a cache key. Both are right.
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await member(root, 'bulma', { displayName: 'Bulma' });
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(workspacePaths(`${root}/bulma`).manifest, past, past);
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    assertEquals((await scanRoster(root, { now: NOW, changedSince: cutoff })).characters, []);

    await renameCharacter(`${root}/bulma`, 'Bulma Briefs', { now: NOW });
    const after = await scanRoster(root, { now: NOW, changedSince: cutoff });
    assertEquals(after.characters.map((c) => c.displayName), ['Bulma Briefs']);
    assertEquals(after.characters[0]!.id, 'bulma', 'the id the cache keys on never moved');
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('a lastBakeId pointing at a missing bake reads as never-baked', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await member(root, 'bulma');
    const paths = workspacePaths(`${root}/bulma`);
    const doc = JSON.parse(await fs.readFile(paths.manifest, 'utf8'));
    doc.lastBakeId = 'deadbeef';
    await fs.writeFile(paths.manifest, canonicalJson(doc));

    const roster = await scanRoster(root, { now: NOW });
    const entry = roster.characters[0]!;
    assertEquals(entry.lastBakeId, 'deadbeef', 'what the manifest says is reported verbatim');
    assertEquals(entry.lastBakedAt, undefined, 'but no time is invented for a bake that is gone');
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('the written index parses as the schema it claims to be', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await member(root, 'bulma');
    const roster = await scanRoster(root, { now: NOW });
    const path = await writeRosterManifest(roster);
    assertEquals(path, `${root}/${ROSTER_FILE}`);
    const round = RosterManifestSchema.parse(JSON.parse(await fs.readFile(path, 'utf8')));
    assertEquals(canonicalJson(round), canonicalJson(roster), 'canonical round-trip');
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('a root that does not exist fails by name', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'spritebook-'));
  try {
    await assertRejects(() => scanRoster(`${root}/nope`), Error, 'Cannot read the roster root');
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
