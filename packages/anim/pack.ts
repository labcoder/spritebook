/**
 * Animation-pack tooling (P3-T1; D-009 packs are catalog data, D-013 bundle
 * CC0 only). A pack on disk is a directory: `pack.json` (AnimPackSchema) +
 * `clips/<clipId>.glb`, each clip glb carrying the FULL source skeleton and
 * exactly ONE animation — that per-clip invariant is what lets retarget and
 * sampling treat "a clip" as one small self-contained file.
 *
 * buildPack splits multi-animation sources (e.g. the Quaternius UAL glbs)
 * into per-clip files. Two traps handled here, both measured on the real UAL
 * data:
 *  - disposing an Animation does NOT dispose its samplers; channels AND
 *    samplers of every dropped animation are disposed explicitly, else ~4.8 MB
 *    of orphaned accessors survive prune() per clip (see
 *    fixtures/_extract-ual.ts, the reference for this gotcha).
 *  - mesh NODES are disposed BEFORE meshes — once the mesh is disposed,
 *    `node.getMesh()` is null and the node can no longer be identified. prune
 *    deliberately excludes NODE so every clip glb keeps the identical, full
 *    skeleton even if some clip leaves joints untracked.
 *
 * Derivation rules (documented once, implemented next to each function):
 *  - clipId: kebab-case of the animation name (toClipId); cross-source name
 *    collisions get `-2`, `-3`, ... in build order.
 *  - category: name-prefix heuristic on the kebab id (clipCategory).
 *  - tags: the kebab id's words + the category, deduped (clipTags).
 */
import { Logger, NodeIO, PropertyType, type Root } from '@gltf-transform/core';
import { prune, resample } from 'npm:@gltf-transform/functions@4.4.1';
import {
  type AnimClipMeta,
  type AnimPack,
  AnimPackSchema,
  canonicalJson,
  parseWith,
  SCHEMA_VERSION,
} from '@spritebook/schema';
import { PACK_CLIP_DIR, PACK_MANIFEST } from './contracts.ts';

/** Pinned generator string: clip-glb bytes must not vary run to run. */
const GENERATOR = 'spritebook-anim-pack@0.1.0';

const SILENT = new Logger(Logger.Verbosity.SILENT);

// ---------------------------------------------------------------------------
// Derivation rules
// ---------------------------------------------------------------------------

/**
 * Kebab-case a source animation name into a clip id base:
 * split on `_`, `-`, whitespace and at lower/digit->Upper camel boundaries,
 * lowercase, join with '-', strip anything outside [a-z0-9-]. Uppercase RUNS
 * stay one word, so `A_TPose` -> `a-tpose` (not `a-t-pose`); digits stick to
 * their word, so `Death01` -> `death01`, `ClimbUp_1m` -> `climb-up-1m`.
 */
export function toClipId(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Category heuristic: a plain prefix test on the kebab-case clip id, first
 * match wins in this order:
 *   pose:       a-tpose, tpose
 *   locomotion: walk, jog, sprint, swim, crouch
 *   idle:       idle
 *   combat:     pistol, sword, punch, melee, bow, shield, spell, hit, death
 *   (no match): other
 * Prefix (not word) matching is deliberate so `death01` hits `death`; the
 * price is that an id like `hitchhike` would read as combat — acceptable for
 * a browse bucket, and `category` stays free-form in the schema.
 */
export function clipCategory(clipIdBase: string): string {
  for (const [category, prefixes] of CATEGORY_PREFIXES) {
    if (prefixes.some((p) => clipIdBase.startsWith(p))) return category;
  }
  return 'other';
}

const CATEGORY_PREFIXES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['pose', ['a-tpose', 'tpose']],
  ['locomotion', ['walk', 'jog', 'sprint', 'swim', 'crouch']],
  ['idle', ['idle']],
  ['combat', ['pistol', 'sword', 'punch', 'melee', 'bow', 'shield', 'spell', 'hit', 'death']],
];

/**
 * Tags = the kebab id's words (in name order) + the category, deduped. E.g.
 * `walk-loop` (locomotion) -> ['walk', 'loop', 'locomotion'] and `idle-loop`
 * (idle) -> ['idle', 'loop'].
 */
export function clipTags(clipIdBase: string, category: string): string[] {
  const tags: string[] = [];
  for (const t of [...clipIdBase.split('-'), category]) {
    if (!tags.includes(t)) tags.push(t);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// buildPack
// ---------------------------------------------------------------------------

/** Pack-level metadata the caller supplies; the rest is derived per clip. */
export interface AnimPackMeta {
  id: string;
  name: string;
  version: string;
  license: string;
  redistributable: boolean;
  source: string;
}

export interface BuildPackOptions {
  /** multi-animation source glbs; ALL must share one skeleton (node names) */
  srcGlbs: string[];
  /** pack directory to (re)create — clips/ inside it is replaced wholesale */
  outDir: string;
  meta: AnimPackMeta;
}

/**
 * Split every animation of every source glb into its own single-animation,
 * skeleton-only clip glb under `outDir/clips/`, derive per-clip metadata, and
 * write a schema-validated canonical `pack.json`. Deterministic: same sources
 * in the same order -> byte-identical clips and manifest.
 */
export async function buildPack(opts: BuildPackOptions): Promise<AnimPack> {
  const io = new NodeIO().setLogger(SILENT);
  const clipsDir = `${opts.outDir}/${PACK_CLIP_DIR}`;
  await Deno.remove(clipsDir, { recursive: true }).catch((err) => {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  });
  await Deno.mkdir(clipsDir, { recursive: true });

  const takenIds = new Set<string>();
  const clips: AnimClipMeta[] = [];
  let skeletonNames: string | undefined;

  for (const srcPath of opts.srcGlbs) {
    const srcBytes = await Deno.readFile(srcPath).catch((err) => {
      throw new Error(`buildPack: cannot read source glb ${srcPath}: ${message(err)}`);
    });
    const probe = await io.readBinary(srcBytes);
    probe.setLogger(SILENT);
    const animNames = probe.getRoot().listAnimations().map((a) => a.getName());
    if (animNames.length === 0) {
      throw new Error(`buildPack: ${srcPath} contains no animations`);
    }

    for (let index = 0; index < animNames.length; index++) {
      const name = animNames[index];
      const idBase = toClipId(name);
      if (idBase.length === 0) {
        throw new Error(
          `buildPack: animation #${index} in ${srcPath} has no kebab-able name (got "${name}")`,
        );
      }
      const id = uniqueId(idBase, takenIds);

      // Fresh parse per clip: brutally simple, and clone semantics can't bite.
      const doc = await io.readBinary(srcBytes);
      doc.setLogger(SILENT);
      const root = doc.getRoot();
      const nodesBefore = root.listNodes().length;

      const anims = root.listAnimations();
      for (let j = 0; j < anims.length; j++) {
        if (j === index) continue;
        // Disposing an Animation does NOT dispose its samplers (the 4.8 MB
        // orphaned-accessor gotcha) — dispose channels and samplers explicitly.
        for (const ch of anims[j].listChannels()) ch.dispose();
        for (const s of anims[j].listSamplers()) s.dispose();
        anims[j].dispose();
      }
      // Mesh NODES first (after mesh.dispose() they are unidentifiable), then
      // skins and meshes.
      let meshNodes = 0;
      for (const node of root.listNodes()) {
        if (node.getMesh()) {
          node.dispose();
          meshNodes++;
        }
      }
      for (const skin of root.listSkins()) skin.dispose();
      for (const mesh of root.listMeshes()) mesh.dispose();

      // resample drops redundant dense-baked keys (UAL keys every joint every
      // frame); prune sweeps the orphaned accessors/materials/textures but is
      // NOT allowed to touch nodes — every clip keeps the identical skeleton.
      await doc.transform(
        resample(),
        prune({
          propertyTypes: [
            PropertyType.ACCESSOR,
            PropertyType.MESH,
            PropertyType.SKIN,
            PropertyType.MATERIAL,
            PropertyType.TEXTURE,
            PropertyType.PRIMITIVE,
            PropertyType.PRIMITIVE_TARGET,
          ],
        }),
      );

      // Postconditions (gltf-pipeline skill: diff counts after every chain).
      const kept = root.listAnimations();
      if (kept.length !== 1 || root.listMeshes().length !== 0 || root.listSkins().length !== 0) {
        throw new Error(
          `buildPack: clip "${name}" (${srcPath}) stripped wrong: ` +
            `${kept.length} animations, ${root.listMeshes().length} meshes, ` +
            `${root.listSkins().length} skins`,
        );
      }
      if (root.listNodes().length !== nodesBefore - meshNodes) {
        throw new Error(
          `buildPack: clip "${name}" (${srcPath}) lost skeleton nodes: ` +
            `${nodesBefore} - ${meshNodes} mesh nodes != ${root.listNodes().length}`,
        );
      }
      const skeleton = root.listNodes().map((n) => n.getName()).sort().join('\n');
      if (skeletonNames === undefined) skeletonNames = skeleton;
      else if (skeleton !== skeletonNames) {
        throw new Error(
          `buildPack: ${srcPath} has a different skeleton (node names) than the first source — ` +
            `a pack carries ONE skeleton convention`,
        );
      }

      const durationS = maxSamplerInput(root);
      if (!(durationS > 0)) {
        throw new Error(
          `buildPack: clip "${name}" (${srcPath}) has zero duration ` +
            `(all keyframes at t=0) — cannot derive a positive durationS`,
        );
      }

      const asset = root.getAsset();
      asset.generator = GENERATOR;
      delete asset.copyright;

      const category = clipCategory(idBase);
      clips.push({
        id,
        name,
        category,
        tags: clipTags(idBase, category),
        durationS,
        loop: name.endsWith('_Loop'),
      });
      await Deno.writeFile(`${clipsDir}/${id}.glb`, await io.writeBinary(doc));
    }
  }

  clips.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pack = parseWith(
    AnimPackSchema,
    {
      schemaVersion: SCHEMA_VERSION,
      id: opts.meta.id,
      name: opts.meta.name,
      version: opts.meta.version,
      license: opts.meta.license,
      redistributable: opts.meta.redistributable,
      source: opts.meta.source,
      skeleton: 'ual-humanoid',
      clips,
    },
    `AnimPack "${opts.meta.id}" (buildPack)`,
  );
  await Deno.writeTextFile(`${opts.outDir}/${PACK_MANIFEST}`, canonicalJson(pack));
  return pack;
}

/** First taker keeps the base id; later name collisions get -2, -3, ... */
function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

/** Clip duration = max keyframe time across every sampler of every animation. */
function maxSamplerInput(root: Root): number {
  let max = 0;
  for (const anim of root.listAnimations()) {
    for (const sampler of anim.listSamplers()) {
      const times = sampler.getInput()?.getArray();
      if (!times) continue;
      for (const t of times) if (t > max) max = t;
    }
  }
  return max;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// loadPack / listClips / importPack
// ---------------------------------------------------------------------------

/**
 * Read + schema-validate `dir/pack.json` and verify every listed clip file
 * exists. Throws with the offending path(s) — never returns a half-valid pack.
 */
export async function loadPack(dir: string): Promise<AnimPack> {
  const pack = parseWith(
    AnimPackSchema,
    await readManifest(dir),
    `AnimPack (${dir}/${PACK_MANIFEST})`,
  );
  const missing: string[] = [];
  for (const clip of pack.clips) {
    const path = `${dir}/${PACK_CLIP_DIR}/${clip.id}.glb`;
    const stat = await Deno.stat(path).catch(() => undefined);
    if (!stat?.isFile) missing.push(path);
  }
  if (missing.length > 0) {
    throw new Error(
      `pack "${pack.id}" is missing ${missing.length} clip file(s):\n  ${missing.join('\n  ')}`,
    );
  }
  return pack;
}

/** `spritebook anim --list [--tag t] [--category c]` core: AND-filter clips. */
export function listClips(
  pack: AnimPack,
  filter?: { tag?: string; category?: string },
): AnimClipMeta[] {
  return pack.clips.filter((c) =>
    (filter?.category === undefined || c.category === filter.category) &&
    (filter?.tag === undefined || c.tags.includes(filter.tag))
  );
}

/**
 * Copy + validate an external pack directory into the packs root as
 * `packsRoot/<pack.id>/` (used by `spritebook anim --import-pack`). Rejects a
 * manifest that does not DECLARE `redistributable` (D-013: personal-license
 * imports must be explicitly false and are never bundled); `false` itself is a
 * valid, importable value. Only the manifest-listed clip files are copied.
 */
export async function importPack(srcDir: string, packsRoot: string): Promise<AnimPack> {
  const raw = await readManifest(srcDir);
  if (
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) &&
    (raw as Record<string, unknown>).redistributable === undefined
  ) {
    throw new Error(
      `cannot import ${srcDir}: pack.json does not declare "redistributable" (D-013). ` +
        `Set true only if the clip license permits redistribution; ` +
        `personal-license imports (e.g. Mixamo) must set false.`,
    );
  }
  const pack = await loadPack(srcDir);
  const destDir = `${packsRoot}/${pack.id}`;
  if (await Deno.stat(destDir).catch(() => undefined)) {
    throw new Error(
      `pack "${pack.id}" is already installed at ${destDir} — remove it first to re-import`,
    );
  }
  await Deno.mkdir(`${destDir}/${PACK_CLIP_DIR}`, { recursive: true });
  await Deno.writeTextFile(`${destDir}/${PACK_MANIFEST}`, canonicalJson(pack));
  for (const clip of pack.clips) {
    await Deno.copyFile(
      `${srcDir}/${PACK_CLIP_DIR}/${clip.id}.glb`,
      `${destDir}/${PACK_CLIP_DIR}/${clip.id}.glb`,
    );
  }
  return pack;
}

/** Read `dir/pack.json` as parsed-but-unvalidated JSON, errors actionable. */
async function readManifest(dir: string): Promise<unknown> {
  const path = `${dir}/${PACK_MANIFEST}`;
  const text = await Deno.readTextFile(path).catch((err) => {
    throw new Error(`not an animation pack: cannot read ${path}: ${message(err)}`);
  });
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${message(err)}`);
  }
}
