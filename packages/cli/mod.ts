/**
 * @spritebook/cli - verb surface. P1-T3 landed `undo`/`redo`; P2-T3 lands
 * `bake` (canonical glb -> bake dir via render->style->pack) and `export`
 * (bake dir -> engine-ready files).
 *
 * ## What `--json` gives you
 *
 * A JOB emits NDJSON: one JobEvent per line, streamed as the work happens —
 * bake, export, gen, pick, rig, identity, prep, models install.
 *
 * A QUERY emits ONE document, because a query has no events to stream: it has
 * an answer. `anim --list`, `anim --import-pack`, `models list`, `rename`,
 * `clone`, and `doctor` are queries. This header used to say `--json` was
 * always NDJSON, which sent anyone piping `models list` into a line reader
 * looking for a bug in the wrong place.
 *
 * On-disk journal layout, next to the manifest:
 *   <manifest>                    canonical JSON document
 *   <manifest>.journal.ndjson     append-only ManifestPatch lines
 *   <manifest>.journal.cursor     how many patches are currently applied
 */
import {
  adapterFor,
  BakeManifestSchema,
  canonicalJson,
  CharacterManifestSchema,
  type ExportTargetId,
  ExportTargetIdSchema,
  type JobEvent,
  ManifestPatchSchema,
  migrateCharacterManifest,
  parseWith,
} from '@spritebook/schema';
import type {
  CameraOverrides,
  CameraPreset,
  CharacterManifest,
  ClipBinding,
  JointEdit,
  OrientationFix,
  StyleOverrides,
  StylePreset,
} from '@spritebook/schema';
import {
  applyPatchOps,
  CAMERA_PRESETS,
  DEFAULT_CAMERA_PRESET_ID,
  encodeEvent,
  readWorkspace,
  recordBake,
  resolveCamera,
  workspacePaths,
} from '@spritebook/core';
import {
  canonicalStyleId,
  DEFAULT_STYLE_PRESET_ID,
  PRESETS,
  resolveStyle,
  STYLE_ALIASES,
  styleAliasNote,
} from '@spritebook/style';
import type { BakeJobSpec, BakeProvenance, ClipBindingSpec } from '@spritebook/pack';
import { BUNDLED_PACK, runBakeJob } from '@spritebook/pack';
import { runExportJob } from '@spritebook/export';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  now?: () => string;
}

interface JournalFiles {
  manifest: string;
  journal: string;
  cursor: string;
}

function files(manifestPath: string): JournalFiles {
  return {
    manifest: manifestPath,
    journal: `${manifestPath}.journal.ndjson`,
    cursor: `${manifestPath}.journal.cursor`,
  };
}

async function readJournal(f: JournalFiles) {
  // upgraded at the read, like every other manifest loader: `undo` on a
  // workspace from an older build would otherwise apply an inverse to a v2
  // document and then be refused by manifestFault for being v2 — a verb whose
  // whole promise is "put it back", failing on documents that are merely old
  const doc = migrateCharacterManifest(JSON.parse(await Deno.readTextFile(f.manifest)));
  const journalText = await Deno.readTextFile(f.journal).catch(() => '');
  const patches = journalText
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l, i) => parseWith(ManifestPatchSchema, JSON.parse(l), `journal line ${i + 1}`));
  const cursorText = await Deno.readTextFile(f.cursor).catch(() => String(patches.length));
  const cursor = Number(cursorText.trim());
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > patches.length) {
    throw new Error(`corrupt cursor file: "${cursorText.trim()}" (journal has ${patches.length})`);
  }
  return { doc, patches, cursor };
}

/**
 * `undo` and `redo` write the DOCUMENT, so what they produce has to still BE a
 * CharacterManifest. ManifestPatchSchema judges the shape of a patch, never
 * the shape of the result — and a journal line can be wrong in ways that shape
 * cannot show: hand-edited, truncated, or written by a build whose inverses
 * were not restores. Writing that result unchecked replaces a working
 * workspace with one no verb can load, which is the worst possible outcome of
 * a verb whose entire promise is "put it back".
 *
 * Returns the refusal message, or undefined when the document is sound.
 */
function manifestFault(doc: unknown, f: JournalFiles, action: string): string | undefined {
  try {
    parseWith(CharacterManifestSchema, doc, `CharacterManifest at "${f.manifest}"`);
    return undefined;
  } catch (err) {
    return `${action} would leave "${f.manifest}" holding an invalid manifest, so nothing was ` +
      `written: ${err instanceof Error ? err.message : String(err)}. The document and ` +
      `"${f.journal}" disagree — restore the journal from version control, or re-run the verb ` +
      `that wrote it.`;
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  // a flag at end-of-line or followed by another flag has NO value — treating
  // the next token as one silently misparses (`--model --character hero`) or
  // silently disables features (`--cache` last = no caching)
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function numFlag(args: string[], name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || raw.startsWith('--')) {
    throw new Error(`--${name} must be a number (got "${raw}")`);
  }
  return n;
}

/** Like numFlag but requires a positive integer (frame counts, pixel sizes). */
function intFlag(args: string[], name: string, fallback: number): number {
  const n = numFlag(args, name, fallback);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--${name} must be a positive integer (got ${n})`);
  }
  return n;
}

/** A seed: a NON-NEGATIVE integer, which is not the same rule as `intFlag`'s.
 *
 * `--seed 0` was refused as "must be a positive integer" by every verb that
 * takes one, while `GenAdapterParamsSchema` says `nonnegative()` and the
 * catalog's own default seed IS 0. A user reproducing a documented run could
 * not type the seed it names. */
function seedFlag(args: string[], fallback: number): number {
  const n = numFlag(args, 'seed', fallback);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--seed must be a non-negative integer (got ${n})`);
  }
  return n;
}

/** Human-readable rendering of an event stream; returns 1 if an error passed. */
async function pump(
  events: AsyncIterable<JobEvent>,
  emit: (e: JobEvent, human: string) => void,
): Promise<number> {
  let failed = 0;
  for await (const e of events) {
    const human = e.t === 'progress'
      ? `[${e.done}/${e.total}] ${e.step}`
      : e.t === 'artifact'
      ? `${e.kind}: ${e.path}`
      : e.t === 'warn'
      ? `warn [${e.code}]: ${e.message}`
      : e.t === 'error'
      ? `error [${e.code}]: ${e.message}`
      : e.t === 'done'
      ? `done in ${e.wallTimeS.toFixed(2)}s`
      : e.t;
    emit(e, human);
    if (e.t === 'error') failed = 1;
  }
  return failed;
}

const DIR_CHOICES = new Set([2, 4, 8, 16]);

/** `--clips walk-loop:6@1.5!hold,idle-loop:4` -> ClipBindingSpec[]. */
function parseClips(raw: string) {
  const seen = new Set<string>();
  return raw.split(',').map((part) => {
    const m = part.trim().match(/^([a-z0-9][a-z0-9-]*):(\d+)(?:@([\d.]+))?(!hold)?$/);
    if (!m) {
      throw new Error(`bad --clips entry "${part.trim()}" - want clip:frames[@speed][!hold]`);
    }
    const frames = Number(m[2]);
    const speed = m[3] ? Number(m[3]) : 1;
    if (frames < 1) throw new Error(`--clips "${m[1]}": frames must be >= 1`);
    if (!(speed > 0)) throw new Error(`--clips "${m[1]}": speed must be > 0`);
    if (seen.has(m[1])) {
      throw new Error(`--clips lists "${m[1]}" twice - one binding per clip`);
    }
    seen.add(m[1]);
    return { clipId: m[1], frames, speed, holdLast: m[4] !== undefined };
  });
}

/** `--adjust quality=high,steps=20` -> params. Values are JSON-parsed so
 * numbers and booleans arrive typed (the backend's paramsSchema is what
 * finally judges them, core-side, before any process is spawned). */
function parseAdjust(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      throw new Error(`bad --adjust entry "${part.trim()}" - want key=value[,key=value]`);
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === '__proto__' || key === 'constructor') {
      throw new Error(`--adjust key "${key}" is not allowed`);
    }
    // the seed is hoisted out of params because provenance depends on it, so
    // gen always overrides params.seed - accepting it here would silently
    // ignore what the user typed and then record a different seed
    if (key === 'seed') {
      throw new Error('set the seed with --seed <n>, not --adjust seed=<n>');
    }
    try {
      out[key] = JSON.parse(value);
    } catch {
      out[key] = value; // a bare string stays a string
    }
  }
  return out;
}

/** The character's own camera + style, when `bake` was pointed at a workspace. */
type CharacterLook = NonNullable<CharacterManifest['look']>;

/**
 * The camera geometry flags as an override object, holding ONLY the ones the
 * user actually typed.
 *
 * Presence detection, not defaults, and that distinction is what makes
 * `--workspace` safe: `intFlag(args, 'cell', 64)` cannot tell "the user asked
 * for 64" from "nobody said anything", so folding defaults in would overwrite a
 * character's stored cell size on every bake that did not restate it.
 */
function cameraOverridesFromFlags(args: string[]): CameraOverrides {
  const out: CameraOverrides = {};
  if (flag(args, 'elevation') !== undefined) out.elevationDeg = numFlag(args, 'elevation', 30);
  if (flag(args, 'directions') !== undefined) {
    const directions = intFlag(args, 'directions', 8);
    // checked here as well as in the schema so the message names the choices
    if (!DIR_CHOICES.has(directions)) throw new Error('--directions must be 2, 4, 8, or 16');
    out.directions = directions as CameraPreset['directions'];
  }
  if (flag(args, 'ppm') !== undefined) out.pixelsPerMeter = intFlag(args, 'ppm', 32);
  if (flag(args, 'cell') !== undefined) out.cellPx = cellFromFlag(args);
  if (flag(args, 'padding') !== undefined) out.paddingPx = intFlag(args, 'padding', 6);
  return out;
}

/**
 * `--cell 64` or `--cell 96x128`.
 *
 * `cellPx` has always been `{w, h}` with the two independent, and this flag has
 * always collapsed one number into both — so a portrait or banner cell was
 * expressible in the manifest and unreachable from the CLI. A bare number still
 * means a square, which is what almost every sprite sheet wants.
 */
function cellFromFlag(args: string[]): { w: number; h: number } {
  const raw = flag(args, 'cell');
  if (raw === undefined) throw new Error('--cell needs a size, like 64 or 96x128');
  const m = /^(\d+)(?:[xX](\d+))?$/.exec(raw.trim());
  if (!m) {
    throw new Error(`--cell must be a pixel size like 64 or 96x128 (got "${raw}")`);
  }
  const w = Number(m[1]);
  const h = m[2] === undefined ? w : Number(m[2]);
  if (w < 1 || h < 1) throw new Error(`--cell sizes must be at least 1 px (got "${raw}")`);
  return { w, h };
}

/**
 * The style fields a flag changes — today just the palette size.
 *
 * `base` is the style this character would bake with WITHOUT flags (its preset
 * refined by whatever `look.overrides` already says), not the raw preset. That
 * matters because `resolveStyle` merges shallow on purpose: `quantize` replaces
 * wholesale, so building the override off the preset would silently discard a
 * dither or a fixed palette the character had already chosen. Spreading the
 * effective quantize keeps `--colors 16` meaning "the same style, more colours".
 */
function styleOverridesFromFlags(args: string[], base: StylePreset): StyleOverrides {
  const out: StyleOverrides = {};
  if (flag(args, 'colors') !== undefined) {
    const maxColors = intFlag(args, 'colors', 8);
    if (base.quantize === undefined) {
      throw new Error(
        `--colors has nothing to set on style "${base.id}": it does not quantize at all, so it ` +
          `has no palette. Pick a style that does (${Object.keys(PRESETS).sort().join(', ')}) ` +
          `or drop the flag.`,
      );
    }
    // the schema's own bound, restated so the message names the flag the user
    // typed rather than a nested field path they never wrote
    if (maxColors < 2 || maxColors > 256) {
      throw new Error(`--colors must be between 2 and 256 (got ${maxColors})`);
    }
    out.quantize = { ...base.quantize, maxColors };
  }
  return out;
}

/**
 * The fields of a resolved style that differ from its preset — the peer of
 * `cameraOverridesOf`, so both halves of `look` record what RAN rather than
 * what was stored before the flags were read.
 */
function styleOverridesOf(preset: StylePreset, resolved: StylePreset): StyleOverrides {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(resolved)) {
    if (k === 'id') continue;
    if (canonicalJson(v) !== canonicalJson(preset[k as keyof StylePreset])) out[k] = v;
  }
  return out as StyleOverrides;
}

/** `--camera` beats the character's stored look, which beats the default. */
export function cameraPresetIdFor(args: string[], look?: CharacterLook): string {
  return flag(args, 'camera') ?? look?.cameraPresetId ?? DEFAULT_CAMERA_PRESET_ID;
}

/** `--style` beats the character's stored look, which beats the default. */
export function stylePresetIdFor(args: string[], look?: CharacterLook): string {
  return flag(args, 'style') ?? look?.stylePresetId ?? DEFAULT_STYLE_PRESET_ID;
}

/**
 * `--clips` beats the character's stored bindings. Disabled bindings are
 * skipped rather than baked at zero frames — `enabled: false` is the user
 * saying "not this one", which is a different statement from deleting it.
 */
function clipsFor(args: string[], animationSet?: ClipBinding[]): ClipBindingSpec[] | undefined {
  const raw = flag(args, 'clips');
  if (raw !== undefined) return parseClips(raw);
  const enabled = animationSet?.filter((c) => c.enabled) ?? [];
  if (enabled.length === 0) return undefined;
  return enabled.map((c) => ({
    clipId: c.clipId,
    frames: c.frames,
    speed: c.speed,
    holdLast: c.holdLast,
  }));
}

/**
 * Whether this bake mirrors: `--mirror` beats `--no-mirror` beats the
 * character's own choice, which beats off.
 *
 * D-008 says mirroring is opt-in and NEVER INFERRED — but what it refuses to
 * infer from is GEOMETRY ("the saving is a lie for anyone asymmetric": a tattoo
 * changes arms, a prosthetic swaps sides, text reads backwards). Reading a
 * stored `mirroring.enabled` is not inference; it is the same explicit choice,
 * made once and remembered, and the run-long `mirroring-on` warning still fires
 * every time. Off stays the default for a character that has never said.
 *
 * `--no-mirror` exists because without it a character who has said yes has no
 * way to say no for one bake — and "delete the field" is not a CLI gesture.
 * Naming both is a contradiction, and the caller refuses it rather than picking
 * a winner.
 */
export function mirroringFor(args: string[], stored?: boolean): boolean {
  if (args.includes('--mirror')) return true;
  if (args.includes('--no-mirror')) return false;
  return stored ?? false;
}

export interface BakeResolution {
  model: string;
  character: string;
  out: string;
  /** the character's stored camera + style, when baking from a workspace */
  look?: CharacterLook;
  /** the character's stored clip bindings, when baking from a workspace */
  animationSet?: ClipBinding[];
  /** the character's stored D-008 choice, when baking from a workspace */
  mirroring?: boolean;
  /** the character's rig and backend, when baking from a workspace */
  provenance?: BakeProvenance;
}

/**
 * The two recipe facts a glb cannot state, read off the character.
 *
 * Both were hardcoded sentinels in `buildCacheInputs` — `{track:'source-skin'}`
 * and `source-mesh@0` — under comments saying the rig stage "lands with Track B"
 * and there is "no generation backend in the T3 path". Both of those worlds
 * ended in P3. What the sentinels cost is truth in a committed artifact:
 * `BakeManifest.inputs` is the record of what a bake ran on, and "re-run exactly
 * this" cannot be honoured from one that names the wrong backend.
 *
 * Each half is independent, because a character can have a rig and no picked
 * result (`rig` works on a bare glb) or a picked result and no rig yet.
 */
export function provenanceOf(manifest?: CharacterManifest): BakeProvenance | undefined {
  if (!manifest) return undefined;
  const picked = manifest.generation.results.find(
    (r) => r.id === manifest.generation.pickedResultId,
  );
  const out: BakeProvenance = {
    ...(manifest.rig ? { rig: manifest.rig } : {}),
    ...(picked
      ? {
        backend: {
          modelId: picked.backend.modelId,
          version: picked.backend.version,
          params: picked.params,
        },
      }
      : {}),
  };
  // nothing to say is not the same as saying nothing: an empty object would
  // still be `provenance` present, and the sentinels are what "no recorded rig,
  // not generated here" is spelled as
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The `bake` verb's flag surface as a BakeJobSpec. Exported because it is the
 * only way to test the wiring without a GPU, and untestable wiring is how
 * `--mirror` went missing: D-008 mirroring was implemented, tested and
 * documented in @spritebook/pack while no flag anywhere reached it.
 *
 * Flags and the character's own look go through ONE resolution path (D-029).
 * Two paths would drift: the flag defaults used to synthesize a camera whose id
 * (`cli-e30x8`) named no preset at all, so a look-driven bake and a
 * flag-driven bake of identical geometry produced different cache keys and
 * could not share a single cached frame.
 */
export function bakeSpecFromFlags(args: string[], resolved: BakeResolution): BakeJobSpec {
  const styleId = stylePresetIdFor(args, resolved.look);
  // the style this character carries, before any flag — the base a flag refines
  const stored = resolveStyle(styleId, resolved.look?.overrides);
  return {
    jobId: 'bake',
    characterId: resolved.character,
    modelPath: resolved.model,
    camera: resolveCamera(cameraPresetIdFor(args, resolved.look), {
      ...resolved.look?.cameraOverrides,
      ...cameraOverridesFromFlags(args), // an explicit flag wins over the stored look
    }),
    style: resolveStyle(styleId, {
      ...resolved.look?.overrides,
      ...styleOverridesFromFlags(args, stored), // same precedence as the camera
    }),
    frames: intFlag(args, 'frames', 6),
    outRoot: resolved.out,
    cacheDir: flag(args, 'cache'),
    onlyInvalidated: args.includes('--only-invalidated'),
    clips: clipsFor(args, resolved.animationSet),
    packDir: flag(args, 'pack'),
    mirroring: mirroringFor(args, resolved.mirroring),
    provenance: resolved.provenance,
  };
}

/**
 * The fields of a resolved camera that differ from its preset — what
 * `look.cameraOverrides` should record.
 *
 * Only the differences, so the manifest says what this character CHANGED
 * rather than restating the preset it already names. Round-trips exactly:
 * resolving a preset against an empty override set returns the preset.
 */
function cameraOverridesOf(preset: CameraPreset, resolved: CameraPreset): CameraOverrides {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(resolved)) {
    if (k === 'id') continue;
    if (canonicalJson(v) !== canonicalJson(preset[k as keyof CameraPreset])) out[k] = v;
  }
  return out as CameraOverrides;
}

/**
 * The character's clip bindings after a bake: what ran, merged over what was
 * already recorded.
 *
 * Merged, not replaced. A binding the manifest carries as `enabled: false` is a
 * clip the user chose to leave out, and a `bake --clips walk-loop:6` that
 * silently deleted it would destroy a choice the bake was never asked about.
 * Existing entries keep their position; new ones append, so the order is a
 * function of history rather than of iteration.
 *
 * Exported for the same reason `bakeSpecFromFlags` is: the only path that
 * reaches it is a clip bake, which needs a GPU and a retargetable skeleton, and
 * untestable wiring is how `--mirror` went missing.
 */
export function mergeAnimationSet(
  existing: ClipBinding[] | undefined,
  ran: ClipBindingSpec[],
  packId: string,
): ClipBinding[] {
  const byId = new Map(ran.map((c) => [c.clipId, c]));
  const out: ClipBinding[] = (existing ?? []).map((prev) => {
    const now = byId.get(prev.clipId);
    byId.delete(prev.clipId);
    // not in this bake: it keeps whatever it said, including enabled: false
    if (now === undefined) return prev;
    return {
      ...prev,
      packId,
      enabled: true,
      frames: now.frames,
      speed: now.speed,
      holdLast: now.holdLast,
    };
  });
  for (const c of byId.values()) {
    out.push({
      clipId: c.clipId,
      packId,
      enabled: true,
      frames: c.frames,
      speed: c.speed,
      holdLast: c.holdLast,
    });
  }
  return out;
}

/**
 * Every flag each verb accepts, so a flag it does NOT accept becomes an error
 * instead of silence. Without this, `spritebook bake --mirror ...` ran a full
 * UNMIRRORED bake and reported `done` — the user paying full GPU cost for 8
 * rendered directions believing 3 were flips. A typo (`--framse 4`) did the
 * same thing more quietly. Keep a verb's row in sync with the flags its branch
 * actually reads; a flag missing here is a flag the user cannot type.
 */
const VERB_FLAGS: Record<string, readonly string[]> = {
  bake: [
    'workspace',
    'model',
    'character',
    'out',
    'camera',
    'style',
    'directions',
    'frames',
    'clips',
    'pack',
    'cell',
    'ppm',
    'colors',
    'elevation',
    'padding',
    'cache',
    'only-invalidated',
    'mirror',
    'no-mirror',
  ],
  export: ['bake', 'out', 'targets', 'fps'],
  undo: ['manifest'],
  redo: ['manifest'],
  anim: ['list', 'packs', 'tag', 'category', 'import-pack', 'into'],
  gen: [
    'workspace',
    'out',
    'character',
    'image',
    'adjust',
    'model',
    'model-version',
    'seed',
    'more-like',
    'height',
    'sidecar',
    'models-dir',
    'catalog',
  ],
  pick: ['workspace', 'out', 'result', 'reproject', 'image', 'sidecar'],
  retexture: [
    'workspace',
    'out',
    'result',
    'seed',
    'adjust',
    'model',
    'model-version',
    'height',
    'sidecar',
    'models-dir',
    'catalog',
  ],
  identity: ['workspace', 'decals', 'attachments', 'bone-mask', 'body'],
  rename: ['workspace', 'name'],
  clone: ['workspace', 'to', 'id', 'name'],
  rig: [
    'model',
    'out',
    'track-a',
    'body',
    'target',
    'height',
    'workspace',
    'face-front',
    'feet-ground',
    'center',
    'rotate',
    'edits',
    'rerun-with-hints',
    'auto-hints',
    'accept',
    'unaccept',
    'backend',
    'seed',
    'no-deform-check',
    'sidecar',
    'models-dir',
  ],
  prep: ['image', 'out', 'sidecar', 'models-dir', 'catalog'],
  models: ['models-dir', 'catalog', 'installed', 'accept-license', 'territory', 'from'],
  doctor: [],
};

/** Accepted everywhere. */
const GLOBAL_FLAGS = ['json'] as const;

/**
 * The `--`-prefixed tokens this verb does not accept. Only `--` tokens are
 * candidates: `flag()` refuses a value beginning with `--`, so no verb can
 * legitimately take one, and positionals (`models install unirig@0.1.0`) are
 * never candidates. An unlisted verb yields nothing — the unknown-verb error
 * further down is the more useful message for `spritebook transmogrify --x`.
 *
 * Object.hasOwn, not a bare index: `spritebook constructor` would otherwise
 * find Object.prototype.constructor and die spreading a function (the same
 * prototype-chain trap the `--style` lookup already guards).
 */
function unknownFlags(verb: string | undefined, args: string[]): string[] {
  if (verb === undefined || !Object.hasOwn(VERB_FLAGS, verb)) return [];
  const accepted = new Set<string>([...VERB_FLAGS[verb], ...GLOBAL_FLAGS]);
  return args.slice(1).filter((a) => a.startsWith('--') && !accepted.has(a.slice(2)));
}

/** Run the CLI. Returns the process exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const now = io.now ?? (() => new Date().toISOString());
  const json = args.includes('--json');
  const verb = args[0];

  const emit = (e: JobEvent, human: string) => {
    if (json) io.stdout(encodeEvent(e).trimEnd());
    else io.stdout(human);
  };
  const fail = (jobId: JobEvent['jobId'], code: string, message: string): number => {
    const e: JobEvent = { t: 'error', jobId, at: now(), code, message, retryable: false };
    if (json) io.stdout(encodeEvent(e).trimEnd());
    else io.stderr(`error: ${message}`);
    return 1;
  };

  // before ANY work: a flag the verb cannot honor must never look like success
  const unknown = unknownFlags(verb, args);
  if (unknown.length > 0) {
    const accepted = [...VERB_FLAGS[verb], ...GLOBAL_FLAGS]
      .map((f) => `--${f}`)
      .sort()
      .join(', ');
    // `--cell=64` reads as the flag "cell=64": flag() takes space-separated
    // values only, so the = form silently fell through to the default
    const eq = unknown.find((u) => u.includes('='));
    const hint = eq
      ? ` (values are space-separated: \`${eq.replace('=', ' ')}\`, not \`${eq}\`)`
      : '';
    return fail(
      verb as JobEvent['jobId'],
      'unknown-flag',
      `Unknown flag${unknown.length > 1 ? 's' : ''} for \`${verb}\`: ${
        unknown.join(', ')
      }${hint} - accepted: ${accepted}`,
    );
  }

  if (verb === '--version' || verb === '-v') {
    const { SPRITEBOOK_VERSION } = await import('./version.ts');
    io.stdout(`spritebook ${SPRITEBOOK_VERSION}`);
    return 0;
  }
  if (verb === 'doctor') {
    const { runDoctor } = await import('./doctor.ts');
    return await runDoctor(args, io);
  }

  if (verb === 'anim') {
    // query/install verbs over animation packs (P3-T1). Like doctor, --json
    // emits ONE JSON document (a query snapshot, not a job stream).
    const { importPack, listClips, loadPack } = await import('@spritebook/anim');
    const jsonOut = (doc: unknown) => io.stdout(JSON.stringify(doc));
    try {
      if (args.includes('--list')) {
        // decodeURIComponent: URL.pathname percent-encodes spaces/non-ASCII in
        // the install path (review F3)
        const packsRoot = flag(args, 'packs') ??
          decodeURIComponent(
            new URL('../anim/packs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
          );
        // every subdir with a pack.json is a pack — imported packs list too
        const packDirs: string[] = [];
        for await (const entry of Deno.readDir(packsRoot)) {
          if (!entry.isDirectory) continue;
          try {
            await Deno.stat(`${packsRoot}/${entry.name}/pack.json`);
            packDirs.push(`${packsRoot}/${entry.name}`);
          } catch {
            // not a pack dir
          }
        }
        if (!packDirs.length) {
          return fail(
            'anim' as JobEvent['jobId'],
            'no-packs',
            `no packs under "${packsRoot}" - import one with --import-pack <dir> --into <root>`,
          );
        }
        packDirs.sort();
        const query = { tag: flag(args, 'tag'), category: flag(args, 'category') };
        const out: { pack: string; clips: unknown[] }[] = [];
        for (const dir of packDirs) {
          const pack = await loadPack(dir);
          const clips = listClips(pack, query);
          out.push({ pack: pack.id, clips });
          if (!json) {
            io.stdout(`${pack.name} (${pack.id}) - ${clips.length}/${pack.clips.length} clips`);
            for (const c of clips) {
              io.stdout(
                `  ${c.id.padEnd(26)} ${c.category.padEnd(11)} ${
                  c.durationS.toFixed(2).padStart(5)
                }s${c.loop ? ' loop' : ''}  [${c.tags.join(', ')}]`,
              );
            }
          }
        }
        if (json) jsonOut(out.length === 1 ? out[0] : { packs: out });
        return 0;
      }
      const importSrc = flag(args, 'import-pack');
      if (importSrc) {
        const into = flag(args, 'into');
        if (!into) {
          return fail(
            'anim' as JobEvent['jobId'],
            'missing-arg',
            '--into <packsRoot> is required with --import-pack',
          );
        }
        const pack = await importPack(importSrc, into);
        if (json) jsonOut({ imported: pack.id, clips: pack.clips.length });
        else io.stdout(`imported pack "${pack.id}" (${pack.clips.length} clips) into ${into}`);
        return 0;
      }
      return fail(
        'anim' as JobEvent['jobId'],
        'missing-arg',
        'anim needs --list [--tag t] [--category c] or --import-pack <dir> --into <packsRoot>',
      );
    } catch (err) {
      return fail(
        'anim' as JobEvent['jobId'],
        'anim-failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'gen' || verb === 'pick' || verb === 'retexture') {
    const { runGenJob, runPickJob, runRetextureJob } = await import('@spritebook/gen');
    const { readWorkspace, sourceImagePath } = await import('@spritebook/core');
    const workspace = flag(args, 'workspace') ?? flag(args, 'out');
    if (!workspace) {
      return fail(
        verb as JobEvent['jobId'],
        'missing-arg',
        '--workspace <dir> is required (the character directory)',
      );
    }
    const sidecarDir = () => {
      const explicit = flag(args, 'sidecar') ?? Deno.env.get('SPRITEBOOK_SIDECAR_DIR');
      if (explicit) return explicit;
      return decodeURIComponent(
        new URL('../../sidecar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      );
    };

    try {
      if (verb === 'pick') {
        const resultId = flag(args, 'result');
        if (!resultId) {
          return fail(
            'pick' as JobEvent['jobId'],
            'missing-arg',
            '--result <rN> is required - `spritebook gen` prints the id it created',
          );
        }
        return await pump(
          runPickJob({
            jobId: 'pick',
            workspace,
            resultId,
            reproject: args.includes('--reproject'),
            imagePath: flag(args, 'image'),
          }),
          emit,
        );
      }

      if (verb === 'retexture') {
        const resultId = flag(args, 'result');
        if (!resultId) {
          return fail(
            'retexture' as JobEvent['jobId'],
            'missing-arg',
            '--result <rN> is required - the result whose mesh you want to keep',
          );
        }
        // The seed defaults to one PAST the highest already recorded, so a bare
        // `retexture --result r1` twice gives two different textures instead of
        // the same one twice. Repeating is what `--seed` is for.
        const manifest = await readWorkspace(workspace);
        const nextSeed = Math.max(0, ...manifest.generation.results.map((r) => r.seed)) + 1;
        return await pump(
          runRetextureJob({
            jobId: 'retexture',
            workspace,
            resultId,
            seed: seedFlag(args, nextSeed),
            params: parseAdjust(flag(args, 'adjust')),
            modelId: flag(args, 'model'),
            version: flag(args, 'model-version'),
            declaredHeightM: flag(args, 'height') !== undefined
              ? numFlag(args, 'height', 1.7)
              : undefined,
            sidecarDir: sidecarDir(),
            modelsRoot: flag(args, 'models-dir'),
            catalogPath: flag(args, 'catalog'),
          }),
          emit,
        );
      }

      // gen
      const character = flag(args, 'character');
      if (!character) {
        return fail('gen' as JobEvent['jobId'], 'missing-arg', '--character <id> is required');
      }
      let image = flag(args, 'image');
      let params = parseAdjust(flag(args, 'adjust'));
      let modelId = flag(args, 'model') ?? 'fixture-gen';
      let seed = flag(args, 'seed') !== undefined ? seedFlag(args, 0) : undefined;

      // --more-like rN: reuse that receipt's backend and params, vary the seed.
      // The new seed is max(existing)+1 - deterministic given the manifest, and
      // always different, so "more like this" explores instead of repeating.
      const moreLike = flag(args, 'more-like');
      if (moreLike) {
        const manifest = await readWorkspace(workspace);
        const parent = manifest.generation.results.find((r) => r.id === moreLike);
        if (!parent) {
          const ids = manifest.generation.results.map((r) => r.id).join(', ') || '(none)';
          return fail(
            'gen' as JobEvent['jobId'],
            'unknown-result',
            `No result "${moreLike}" to vary - results: ${ids}`,
          );
        }
        modelId = flag(args, 'model') ?? parent.backend.modelId;
        params = { ...parent.params, ...params };
        delete params.seed;
        seed ??= Math.max(...manifest.generation.results.map((r) => r.seed)) + 1;
        image ??= sourceImagePath(workspace, manifest);
      }
      if (!image) {
        return fail(
          'gen' as JobEvent['jobId'],
          'missing-arg',
          '--image <cutout.png> is required (run `spritebook prep` to make one)',
        );
      }

      return await pump(
        runGenJob({
          jobId: 'gen',
          characterId: character as never,
          workspace,
          imagePath: image,
          modelId,
          version: flag(args, 'model-version'),
          seed: seed ?? 0,
          params,
          declaredHeightM: flag(args, 'height') !== undefined
            ? numFlag(args, 'height', 1.7)
            : undefined,
          sidecarDir: sidecarDir(),
          modelsRoot: flag(args, 'models-dir'),
          catalogPath: flag(args, 'catalog'),
        }),
        emit,
      );
    } catch (err) {
      return fail(
        verb as JobEvent['jobId'],
        'bad-args',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'identity') {
    // the Track A identity layer: decals, attachments, bone mask - applied to
    // canonical/model.glb and journaled, so `spritebook undo` takes the whole
    // identity change back as ONE step
    const workspace = flag(args, 'workspace');
    if (!workspace) {
      return fail(
        'identity' as JobEvent['jobId'],
        'missing-arg',
        '--workspace <dir> is required (the character directory)',
      );
    }
    const { runIdentityJob } = await import('@spritebook/gen');
    const schema = await import('@spritebook/schema');
    try {
      const readJson = async (name: string) => {
        const path = flag(args, name);
        if (args.includes(`--${name}`) && !path) {
          throw new Error(`--${name} needs a JSON file path`);
        }
        if (!path) return undefined;
        return JSON.parse(await Deno.readTextFile(path));
      };
      const decalsRaw = await readJson('decals');
      const attachmentsRaw = await readJson('attachments');
      const boneMaskRaw = await readJson('bone-mask');
      const decals = decalsRaw === undefined ? undefined : schema.parseWith(
        schema.DecalPlacementSchema.array(),
        decalsRaw,
        'decals file',
      );
      const attachments = attachmentsRaw === undefined ? undefined : schema.parseWith(
        schema.AttachmentPlacementSchema.array(),
        attachmentsRaw,
        'attachments file',
      );
      const boneMask = boneMaskRaw === undefined ? undefined : schema.parseWith(
        schema.BoneMaskSchema,
        boneMaskRaw,
        'bone-mask file',
      );
      if (!decals && !attachments && !boneMask) {
        return fail(
          'identity' as JobEvent['jobId'],
          'missing-arg',
          'identity needs at least one of --decals <json>, --attachments <json>, --bone-mask <json>',
        );
      }
      const bodyDir = flag(args, 'body');
      return await pump(
        runIdentityJob({
          jobId: 'identity',
          workspace,
          bodyManifestPath: bodyDir ? `${bodyDir}/body.json` : undefined,
          decals,
          attachments,
          boneMask,
        }),
        emit,
      );
    } catch (err) {
      return fail(
        'identity' as JobEvent['jobId'],
        'bad-args',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'rename' || verb === 'clone') {
    // the two verbs the identity law makes cheap (D-011): rename touches one
    // mutable field and invalidates nothing; clone mints a NEW immutable id
    const { cloneCharacter, renameCharacter } = await import('@spritebook/core');
    const workspace = flag(args, 'workspace');
    if (!workspace) {
      return fail(
        verb as JobEvent['jobId'],
        'missing-arg',
        '--workspace <dir> is required (the character directory)',
      );
    }
    try {
      if (verb === 'rename') {
        const name = flag(args, 'name');
        if (!name) {
          return fail(
            'rename' as JobEvent['jobId'],
            'missing-arg',
            '--name <new name> is required',
          );
        }
        const m = await renameCharacter(workspace, name);
        if (json) io.stdout(JSON.stringify({ id: m.id, displayName: m.displayName }));
        else io.stdout(`renamed to "${m.displayName}" (id ${m.id} unchanged - nothing rebakes)`);
        return 0;
      }
      const to = flag(args, 'to');
      const id = flag(args, 'id');
      if (!to || !id) {
        return fail(
          'clone' as JobEvent['jobId'],
          'missing-arg',
          '--to <dir> and --id <new-character-id> are required',
        );
      }
      const m = await cloneCharacter(workspace, to, { id, displayName: flag(args, 'name') });
      if (json) io.stdout(JSON.stringify({ id: m.id, displayName: m.displayName, workspace: to }));
      else io.stdout(`cloned to ${to} as "${m.displayName}" (id ${m.id})`);
      return 0;
    } catch (err) {
      return fail(
        verb as JobEvent['jobId'],
        `${verb}-failed`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'rig') {
    // Track B auto-rig + the repair verbs (P3-T3). Tier 2 rewrites the mesh
    // and so runs BEFORE prediction; tier 1 moves joints on the rigged file.

    // --accept / --unaccept: the REVIEW half of the deform gate, and a pure
    // manifest patch — no model, no sidecar, no GPU. Both rig tracks write
    // `accepted: false` ("theirs to set"), the bake warns while it stays
    // false, and this is the verb that sets it. A query-style sub-mode like
    // `anim --list`, not a job: one decision in, one document out.
    if (args.includes('--accept') || args.includes('--unaccept')) {
      if (args.includes('--accept') && args.includes('--unaccept')) {
        return fail(
          'rig' as JobEvent['jobId'],
          'bad-args',
          '--accept and --unaccept contradict each other - pass one',
        );
      }
      const workspace = flag(args, 'workspace');
      if (!workspace) {
        return fail(
          'rig' as JobEvent['jobId'],
          'missing-arg',
          '--accept needs --workspace <dir> (the character whose rig you reviewed)',
        );
      }
      const accepted = args.includes('--accept');
      try {
        const { readWorkspace: read, setRigState } = await import('@spritebook/core');
        const manifest = await read(workspace);
        if (!manifest.rig) {
          return fail(
            'rig' as JobEvent['jobId'],
            'no-rig',
            `"${manifest.id}" has no rig to ${accepted ? 'accept' : 'unaccept'} - run ` +
              '`spritebook rig --model ... --workspace ...` first',
          );
        }
        if (manifest.rig.accepted === accepted) {
          return fail(
            'rig' as JobEvent['jobId'],
            'no-change',
            `this rig is already ${accepted ? 'accepted' : 'unaccepted'} - nothing to record`,
          );
        }
        // ONE journaled patch, so `spritebook undo` takes the decision back
        const m = await setRigState(workspace, { ...manifest.rig, accepted }, {
          label: accepted ? 'Accept rig' : 'Unaccept rig',
        });
        if (json) {
          io.stdout(JSON.stringify({
            id: m.id,
            accepted,
            jointCount: m.rig!.jointCount,
            track: m.rig!.track,
          }));
        } else {
          io.stdout(
            accepted
              ? `rig accepted (${m.rig!.jointCount} joints, track ${m.rig!.track}) - ` +
                `bake will stop warning about it`
              : `rig unaccepted - bake will warn about it again`,
          );
        }
        return 0;
      } catch (err) {
        return fail(
          'rig' as JobEvent['jobId'],
          'accept-failed',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const model = flag(args, 'model');
    const out = flag(args, 'out');
    if (!model || !out) {
      return fail(
        'rig' as JobEvent['jobId'],
        'missing-arg',
        '--model <glb> and --out <dir> are required',
      );
    }
    // Track A: fit the bundled canonical body - deterministic core code, no
    // sidecar, no GPU, no registry backend. Track B (below) predicts a fresh
    // skeleton via UniRig; --track-a is the roster path.
    if (args.includes('--track-a')) {
      const body = flag(args, 'body');
      const target = flag(args, 'target') ?? model;
      if (!body) {
        return fail(
          'rig' as JobEvent['jobId'],
          'missing-arg',
          '--track-a needs --body <dir> (a bundled body lives at packages/rig/bodies/ubc-male)',
        );
      }
      // the same bad-args boundary Track B and gen keep: numFlag throws on a
      // malformed --height, and a raw stack trace would break the NDJSON
      // contract --json promises
      try {
        const { runFitJob } = await import('@spritebook/rig');
        return await pump(
          runFitJob({
            jobId: 'rig',
            bodyDir: body,
            targetPath: target,
            outDir: out,
            heightM: flag(args, 'height') !== undefined ? numFlag(args, 'height', 1.7) : undefined,
            workspace: flag(args, 'workspace'),
          }),
          emit,
        );
      } catch (err) {
        return fail(
          'rig' as JobEvent['jobId'],
          'bad-args',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const registry = await import('@spritebook/registry');
    const { runRigJob } = await import('@spritebook/rig');
    try {
      const fixes: OrientationFix[] = [];
      for (const f of ['face-front', 'feet-ground', 'center'] as const) {
        if (args.includes(`--${f}`)) fixes.push(f);
      }
      const rotate = flag(args, 'rotate');
      if (rotate !== undefined) {
        if (!['90', '180', '270'].includes(rotate)) {
          return fail('rig' as JobEvent['jobId'], 'bad-args', '--rotate must be 90, 180 or 270');
        }
        fixes.push(`rotate-${rotate}` as OrientationFix);
      }

      let edits: JointEdit[] = [];
      const editsPath = flag(args, 'edits');
      if (args.includes('--edits') && !editsPath) {
        return fail('rig' as JobEvent['jobId'], 'bad-args', '--edits needs a patch.json path');
      }
      if (editsPath) {
        const { JointEditsFileSchema } = await import('@spritebook/schema');
        edits = parseWith(
          JointEditsFileSchema,
          JSON.parse(await Deno.readTextFile(editsPath)),
          `joint edits file "${editsPath}"`,
        ).edits;
      }
      let rerunWithHints = args.includes('--rerun-with-hints');

      // --auto-hints: derive the edits from the previous run's own deform
      // report instead of asking the user to author them — each torn joint's
      // target is the centroid of the flesh it drives. Measured across three
      // subjects (HINTS-REPORT.md): a big offset repairs decisively, a joint
      // already on its centroid does not move, and the split is REPORTED so
      // the residual reads as a backend limit, not as under-clicking.
      if (args.includes('--auto-hints')) {
        if (editsPath || rerunWithHints) {
          return fail(
            'rig' as JobEvent['jobId'],
            'bad-args',
            '--auto-hints derives the edits and implies the rerun - combining it with --edits ' +
              'or --rerun-with-hints would mean two sources of truth for one joint',
          );
        }
        const outDir = flag(args, 'out');
        if (!outDir) {
          return fail('rig' as JobEvent['jobId'], 'missing-arg', '--auto-hints needs --out <dir>');
        }
        const { DeformReportSchema, RigSkeletonSchema } = await import('@spritebook/schema');
        const { deriveAutoHints } = await import('@spritebook/rig');
        let report, skeleton;
        try {
          report = parseWith(
            DeformReportSchema,
            JSON.parse(await Deno.readTextFile(`${outDir}/deform-report.json`)),
            'DeformReport',
          );
          skeleton = parseWith(
            RigSkeletonSchema,
            JSON.parse(await Deno.readTextFile(`${outDir}/rig.json`)),
            'RigSkeleton',
          );
        } catch (err) {
          return fail(
            'rig' as JobEvent['jobId'],
            'no-previous-rig',
            `--auto-hints reads the PREVIOUS run's deform-report.json, rig.json and rigged.glb ` +
              `from --out, and "${outDir}" does not have them: ${
                err instanceof Error ? err.message : String(err)
              }. Run \`spritebook rig\` once first.`,
          );
        }
        const auto = await deriveAutoHints(`${outDir}/rigged.glb`, report, skeleton);
        if (auto.crossComponent.length > 0) {
          const list = auto.crossComponent
            .map((c) => `${c.joint} (${c.components} pieces)`)
            .join(', ');
          const w: JobEvent = {
            t: 'warn',
            jobId: 'rig' as JobEvent['jobId'],
            at: now(),
            code: 'tear-crosses-components',
            message: `${auto.crossComponent.length} flagged joint` +
              `${auto.crossComponent.length === 1 ? '' : 's'} drive DETACHED pieces of the ` +
              `mesh: ${list}. This tear crosses components - the joint is being asked to move ` +
              `geometry it does not touch, so no placement hint can repair it. Join the pieces ` +
              `before rigging if they should move together.`,
          };
          emit(w, `warn [${w.code}]: ${w.message}`);
        }
        if (auto.belowFloor.length > 0) {
          const list = auto.belowFloor
            .map((b) => `${b.joint} (${(b.offsetM * 1000).toFixed(0)} mm)`)
            .join(', ');
          const w: JobEvent = {
            t: 'warn',
            jobId: 'rig' as JobEvent['jobId'],
            at: now(),
            code: 'no-placement-offset',
            message: `${auto.belowFloor.length} flagged joint` +
              `${auto.belowFloor.length === 1 ? ' is' : 's are'} already sitting on the flesh ` +
              `they drive: ${list}. There is no placement offset to exploit, so re-hinting ` +
              `them cannot repair their tearing - that residual is a limit of the skinning ` +
              `backend, not something more hinting will fix.`,
          };
          emit(w, `warn [${w.code}]: ${w.message}`);
        }
        if (auto.unmeasurable.length > 0) {
          const w: JobEvent = {
            t: 'warn',
            jobId: 'rig' as JobEvent['jobId'],
            at: now(),
            code: 'hint-unmeasurable',
            message: `could not measure ${auto.unmeasurable.join(', ')} - no vertices above ` +
              `the weight floor, or missing from the skeleton.`,
          };
          emit(w, `warn [${w.code}]: ${w.message}`);
        }
        if (auto.edits.length === 0) {
          const why = auto.crossComponent.length > 0
            ? 'every flagged joint either straddles detached pieces of the mesh or already sits ' +
              'on the flesh it drives'
            : 'every flagged joint already sits on the flesh it drives';
          return fail(
            'rig' as JobEvent['jobId'],
            'no-placement-offset',
            `${why}, so auto-hints has nothing to move. Re-running would be a plain re-roll ` +
              `wearing a repair costume; the tearing that remains is a limit of the geometry ` +
              `and the skinning backend, not something more hinting will fix.`,
          );
        }
        edits = auto.edits;
        rerunWithHints = true;
      }

      if (rerunWithHints && edits.length === 0) {
        return fail(
          'rig' as JobEvent['jobId'],
          'bad-args',
          '--rerun-with-hints needs --edits <patch.json>: the hints ARE your previous nudges',
        );
      }

      const backend = flag(args, 'backend') ?? 'unirig';
      const root = flag(args, 'models-dir') ?? registry.defaultModelsRoot();
      const installed = await registry.resolveInstalled(root, backend);
      if (!installed) {
        return fail(
          'rig' as JobEvent['jobId'],
          'model-missing',
          `Rig backend "${backend}" is not installed - run \`spritebook models install ${backend}\` ` +
            `first (models root: ${root})`,
        );
      }
      const sidecarDir = flag(args, 'sidecar') ?? Deno.env.get('SPRITEBOOK_SIDECAR_DIR') ??
        decodeURIComponent(
          new URL('../../sidecar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
        );

      return await pump(
        runRigJob({
          jobId: 'rig',
          modelPath: model,
          outDir: out,
          sidecarDir,
          modelDir: registry.versionDir(root, backend, installed.version),
          backend,
          seed: seedFlag(args, 0),
          orientationFixes: fixes,
          edits,
          rerunWithHints,
          skipDeformCheck: args.includes('--no-deform-check'),
          workspace: flag(args, 'workspace'),
        }),
        emit,
      );
    } catch (err) {
      return fail(
        'rig' as JobEvent['jobId'],
        'bad-args',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'prep') {
    // image prep (P3-T2): rembg cutout + pose preflight through the sidecar.
    // The weight comes from the registry (never auto-downloaded by the
    // adapter); the sidecar dir defaults to the repo checkout and is
    // overridable for installed layouts.
    const image = flag(args, 'image');
    const out = flag(args, 'out');
    if (!image || !out) {
      return fail(
        'prep' as JobEvent['jobId'],
        'missing-arg',
        '--image <file> and --out <dir> are required',
      );
    }
    const registry = await import('@spritebook/registry');
    const { SidecarSession } = await import('@spritebook/core');
    try {
      const root = flag(args, 'models-dir') ?? registry.defaultModelsRoot();
      const installed = await registry.resolveInstalled(root, 'rembg-u2net');
      if (!installed) {
        return fail(
          'prep' as JobEvent['jobId'],
          'model-missing',
          'rembg-u2net is not installed - run `spritebook models install rembg-u2net` first ' +
            `(models root: ${root})`,
        );
      }
      const modelDir = registry.versionDir(root, 'rembg-u2net', installed.version);
      // the adapter name came from the catalog once `gen`'s copy of this
      // assumption turned out to be wrong; `prep` only worked because it
      // hardcoded the right answer
      const prepCatalog = await registry.loadCatalog(flag(args, 'catalog'));
      const prepEntry = prepCatalog.models.find((m) => m.id === 'rembg-u2net');
      const prepVersion = prepEntry?.versions.find((v) => v.version === installed.version);
      const prepAdapter = prepVersion
        ? adapterFor('rembg-u2net', prepVersion, 'imageprep')
        : 'rembg';
      let sidecarDir = flag(args, 'sidecar') ?? Deno.env.get('SPRITEBOOK_SIDECAR_DIR');
      if (!sidecarDir) {
        const repoSidecar = decodeURIComponent(
          new URL('../../sidecar', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
        );
        try {
          await Deno.stat(`${repoSidecar}/pyproject.toml`);
          sidecarDir = repoSidecar;
        } catch {
          return fail(
            'prep' as JobEvent['jobId'],
            'sidecar-missing',
            'cannot find the sidecar project - pass --sidecar <dir> or set SPRITEBOOK_SIDECAR_DIR',
          );
        }
      }
      await Deno.mkdir(out, { recursive: true });
      const session = new SidecarSession({ sidecarDir });
      try {
        return await pump(
          session.run({
            jobId: 'prep' as JobEvent['jobId'],
            kind: prepAdapter,
            params: { imagePath: image, outDir: out, modelDir },
          }),
          emit,
        );
      } finally {
        await session.dispose();
      }
    } catch (err) {
      return fail(
        'prep' as JobEvent['jobId'],
        'prep-failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'models') {
    // registry verbs (P3-T2, D-009): list is a query snapshot; install/verify/
    // rm are job streams with the same event discipline as bake/export.
    const registry = await import('@spritebook/registry');
    const jsonOut = (doc: unknown) => io.stdout(JSON.stringify(doc));
    const sub = args[1];
    try {
      const root = flag(args, 'models-dir') ?? registry.defaultModelsRoot();
      if (sub === 'list') {
        const catalog = await registry.loadCatalog(flag(args, 'catalog'));
        const all = await registry.runListQuery({ catalog, root });
        const rows = args.includes('--installed')
          ? all
            .map((m) => ({ ...m, versions: m.versions.filter((v) => v.installed) }))
            .filter((m) => m.versions.length > 0)
          : all;
        if (json) jsonOut({ models: rows });
        else if (rows.length === 0) {
          io.stdout(args.includes('--installed') ? 'no models installed' : 'catalog is empty');
        } else {
          for (const m of rows) {
            const terr = m.license.excludedTerritories?.length
              ? ` [license excludes ${m.license.excludedTerritories.join(', ')}]`
              : '';
            io.stdout(
              `${m.id.padEnd(14)} ${m.kind.padEnd(10)} ${m.displayName} - ${
                m.license.spdx ?? m.license.name
              }${terr}`,
            );
            for (const v of m.versions) {
              const size = `${(v.diskBytes / 1e9).toFixed(2).padStart(6)} GB`;
              const vram = v.minVramGb ? `  >=${v.minVramGb} GiB VRAM` : '';
              io.stdout(
                `  ${v.version.padEnd(12)} ${size}  ${v.platforms.join(',')}${vram}${
                  v.installed ? '  [installed]' : ''
                }`,
              );
            }
          }
        }
        return 0;
      }
      if (sub === 'install' || sub === 'verify' || sub === 'rm') {
        const ref = args[2];
        if (!ref || ref.startsWith('--')) {
          return fail(
            'models' as JobEvent['jobId'],
            'missing-arg',
            `models ${sub} <id[@version]> is required - see \`spritebook models list\``,
          );
        }
        const [modelId, version] = ref.split('@', 2);
        if (sub === 'install') {
          const catalog = await registry.loadCatalog(flag(args, 'catalog'));
          // --from <dir>: take the bytes from disk instead of the network.
          // Hashes are still verified against the catalog pin, so this is a
          // delivery route, not a weaker guarantee (offline installs; reusing
          // bytes another tool already downloaded).
          const from = flag(args, 'from');
          if (args.includes('--from') && !from) {
            return fail('models' as JobEvent['jobId'], 'bad-args', '--from needs a directory path');
          }
          let fetcher;
          if (from) {
            const entry = catalog.models.find((m) => m.id === modelId);
            const v = entry?.versions.find((x) => x.version === (version ?? x.version));
            if (!v) {
              return fail(
                'models' as JobEvent['jobId'],
                'unknown-model',
                `cannot resolve "${ref}" in the catalog to lay out --from files`,
              );
            }
            fetcher = registry.fetchFromDir(from, v.files);
          }
          return await pump(
            registry.runInstallJob({
              jobId: 'models',
              catalog,
              root,
              modelId,
              version,
              acceptLicense: args.includes('--accept-license'),
              territory: flag(args, 'territory'),
              ...(fetcher ? { fetcher } : {}),
            }),
            emit,
          );
        }
        if (sub === 'verify') {
          return await pump(
            registry.runVerifyJob({
              jobId: 'models',
              catalog: await registry.loadCatalog(flag(args, 'catalog')),
              root,
              modelId,
              version,
            }),
            emit,
          );
        }
        return await pump(registry.runRmJob({ jobId: 'models', root, modelId, version }), emit);
      }
      return fail(
        'models' as JobEvent['jobId'],
        'missing-arg',
        'models needs a subcommand: list [--installed] | install <id[@version]> ' +
          '[--accept-license] [--territory CC] | verify <id[@version]> | rm <id[@version]>',
      );
    } catch (err) {
      return fail(
        'models' as JobEvent['jobId'],
        'models-failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb === 'bake') {
    const bakeId = 'bake' as JobEvent['jobId'];
    // --workspace supplies the model, the character id, the output root, and
    // the character's own look + clips; every one of those is still overridable
    // by its flag. Optional, like `rig --workspace`: without it `bake` behaves
    // exactly as it always has.
    const workspace = flag(args, 'workspace');
    let manifest: CharacterManifest | undefined;
    if (workspace !== undefined) {
      try {
        manifest = await readWorkspace(workspace);
      } catch (err) {
        return fail(bakeId, 'no-workspace', err instanceof Error ? err.message : String(err));
      }
    }
    const ws = workspace === undefined ? undefined : workspacePaths(workspace);
    const model = flag(args, 'model') ?? ws?.canonicalModel;
    const character = flag(args, 'character') ?? manifest?.id;
    const out = flag(args, 'out') ?? ws?.bakesDir;
    if (!model || !character || !out) {
      return fail(
        bakeId,
        'missing-arg',
        '--model <glb>, --character <id>, and --out <dir> are required - or --workspace <dir>, ' +
          'which supplies all three from the character it holds',
      );
    }
    const look = manifest?.look;
    // The id as ASKED FOR, then the live preset it names. A character baked
    // before a rename carries the old string in its look, so `asked` is what
    // the user (or their manifest) said and `styleId` is what runs — every
    // lookup below has to use the canonical one or an alias would die on
    // `PRESETS[undefined]`.
    const asked = stylePresetIdFor(args, look);
    const styleId = canonicalStyleId(asked);
    // Object.hasOwn: `--style __proto__` must be unknown-style, not a
    // prototype-chain hit that dies later as a confusing TypeError (m7)
    if (!Object.hasOwn(PRESETS, styleId)) {
      return fail(
        bakeId,
        'unknown-style',
        `Unknown style "${asked}"${
          flag(args, 'style') === undefined ? " (from the character's look)" : ''
        } - available: ${Object.keys(PRESETS).sort().join(', ')}` +
          ` (retired ids that still resolve: ${Object.keys(STYLE_ALIASES).sort().join(', ')})`,
      );
    }
    const aliasNote = styleAliasNote(asked);
    const cameraId = cameraPresetIdFor(args, look);
    if (!Object.hasOwn(CAMERA_PRESETS, cameraId)) {
      return fail(
        bakeId,
        'unknown-camera',
        `Unknown camera preset "${cameraId}"${
          flag(args, 'camera') === undefined ? " (from the character's look)" : ''
        } - available: ${Object.keys(CAMERA_PRESETS).sort().join(', ')}`,
      );
    }
    // a valueless --clips must not silently bake the legacy idle stub, and a
    // --pack with no clips to resolve changes nothing - both are user error
    if (args.includes('--clips') && !flag(args, 'clips')) {
      return fail(
        bakeId,
        'bad-args',
        '--clips needs a value: clip:frames[@speed][!hold][,...] - see `spritebook anim --list`',
      );
    }
    if (args.includes('--pack') && !flag(args, 'pack')) {
      return fail(bakeId, 'bad-args', '--pack needs a directory path');
    }
    // naming both is a contradiction, and picking a winner would mean baking
    // the opposite of half of what the user typed
    if (args.includes('--mirror') && args.includes('--no-mirror')) {
      return fail(
        bakeId,
        'bad-args',
        '--mirror and --no-mirror contradict each other - pass one, or neither to use the ' +
          "character's own setting",
      );
    }
    const stored = manifest?.animationSet?.filter((c) => c.enabled) ?? [];
    if (flag(args, 'pack') && !flag(args, 'clips') && stored.length === 0) {
      return fail(
        bakeId,
        'bad-args',
        '--pack only applies when there are clips to resolve: pass --clips, or point --workspace ' +
          'at a character whose animationSet has enabled bindings',
      );
    }

    // Which pack this bake reads. Resolved only when the answer is USED: to
    // validate stored bindings against, and to record in the writeback. A bake
    // with no workspace records nothing, and an idle-stub bake opens no pack at
    // all — neither should start failing on a pack.json it never needed.
    const packDir = flag(args, 'pack') ?? BUNDLED_PACK;
    let packId: string | undefined;
    if (workspace !== undefined && (flag(args, 'clips') !== undefined || stored.length > 0)) {
      try {
        const { loadPack } = await import('@spritebook/anim');
        packId = (await loadPack(packDir)).id;
      } catch (err) {
        return fail(
          bakeId,
          'bad-pack',
          `Cannot read an animation pack at "${packDir}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // A stored binding names the pack its clip came FROM. Resolving it
      // against a different pack renders a different animation under the same
      // clip id and reports done, so the mismatch is refused rather than
      // guessed at. Only stored bindings are checked: `--clips` is the user
      // naming ids right now, against the pack they also named.
      const foreign = flag(args, 'clips') === undefined
        ? stored.find((c) => c.packId !== packId)
        : undefined;
      if (foreign) {
        return fail(
          bakeId,
          'pack-mismatch',
          `This character's clip "${foreign.clipId}" comes from pack "${foreign.packId}", but ` +
            `this bake reads "${packId}" at "${packDir}". Pass --pack <dir> pointing at ` +
            `"${foreign.packId}" - resolving the id against another pack would bake a ` +
            `different animation under the same name.`,
        );
      }
    }

    let spec: BakeJobSpec;
    try {
      spec = bakeSpecFromFlags(args, {
        model,
        character,
        out,
        look,
        animationSet: stored,
        mirroring: manifest?.mirroring.enabled,
        provenance: provenanceOf(manifest),
      });
    } catch (err) {
      return fail(bakeId, 'bad-args', err instanceof Error ? err.message : String(err));
    }
    // The rig's own deform check said no, and nothing has said yes since: both
    // rig tracks write `accepted: false` and leave it "theirs to set", and no
    // verb sets it yet. So this cannot be a refusal without dead-ending every
    // rigged character — but the P3 exit run shipped 48 frames off a rig with
    // 37 of 40 joints flagged and not one line said so at bake time. Loud warn.
    if (manifest?.rig && !manifest.rig.accepted) {
      const w: JobEvent = {
        t: 'warn',
        jobId: bakeId,
        at: now(),
        code: 'rig-unaccepted',
        message: `this character's rig (${manifest.rig.jointCount} joints, track ` +
          `${manifest.rig.track}) was never accepted - the deform check flagged joints when it ` +
          `was made, and RigState.accepted is still false. The sprites will bake with that ` +
          `skinning. Check deform-report.json in the rig output, repair with ` +
          `\`spritebook rig --edits <patch.json>\` or \`--rerun-with-hints\`, or - if you have ` +
          `looked and the sprites are fine - record that with \`spritebook rig --workspace ` +
          `<dir> --accept\`. Baking continues; this is a warning, not a refusal.`,
      };
      emit(w, `warn [${w.code}]: ${w.message}`);
    }
    // A retired style id resolved rather than failing, and says so. Emitted here
    // rather than thrown from resolveStyle because resolution returns a style
    // and has no channel for a message — and because a manifest carrying an old
    // id is a normal thing to own, not an error to fix.
    if (aliasNote !== undefined) {
      const w: JobEvent = {
        t: 'warn',
        jobId: bakeId,
        at: now(),
        code: 'style-alias',
        message: `${aliasNote}${
          flag(args, 'style') === undefined ? " The id came from the character's look." : ''
        }`,
      };
      emit(w, `warn [${w.code}]: ${w.message}`);
    }
    let bakeDir: string | undefined;
    let code: number;
    try {
      code = await pump(runBakeJob(spec), (e, human) => {
        if (e.t === 'artifact' && e.kind === 'bake-dir') bakeDir = e.path;
        emit(e, human);
      });
    } catch (err) {
      return fail(bakeId, 'bad-args', err instanceof Error ? err.message : String(err));
    }
    if (code !== 0 || workspace === undefined || bakeDir === undefined) return code;

    // D-029: record what this bake ran with, as ONE journaled patch. A failed
    // bake records nothing — `lastBakeId` names a bake dir that has to exist.
    try {
      const baked = parseWith(
        BakeManifestSchema,
        JSON.parse(await Deno.readTextFile(`${bakeDir}/manifest.json`)),
        `BakeManifest at "${bakeDir}/manifest.json"`,
      );
      const cameraOverrides = cameraOverridesOf(CAMERA_PRESETS[cameraId], spec.camera);
      const overrides = styleOverridesOf(PRESETS[styleId], spec.style);
      await recordBake(workspace, {
        look: {
          cameraPresetId: cameraId,
          // omitted when the camera IS the preset: recording an override set
          // identical to the preset would claim a change nobody made
          ...(Object.keys(cameraOverrides).length > 0 ? { cameraOverrides } : {}),
          stylePresetId: styleId,
          // what this bake RAN with, on the same terms as the camera above:
          // `--colors` edits a style sub-field now, so echoing back whatever the
          // manifest already carried would drop the change on the next bake
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
        },
        animationSet: spec.clips === undefined || packId === undefined
          ? undefined
          : mergeAnimationSet(manifest?.animationSet, spec.clips, packId),
        mirroring: spec.mirroring === true,
        lastBakeId: baked.bakeId,
      }, { now: io.now });
    } catch (err) {
      // The atlases are on disk and valid; only the bookkeeping failed. Saying
      // "done" would leave the manifest quietly disagreeing with the bake dir.
      return fail(
        bakeId,
        'record-failed',
        `The bake finished at "${bakeDir}", but recording it in "${workspace}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return code;
  }

  if (verb === 'export') {
    const bakeDir = flag(args, 'bake');
    const out = flag(args, 'out');
    const targetsRaw = flag(args, 'targets');
    if (!bakeDir || !out || !targetsRaw) {
      return fail(
        'export' as JobEvent['jobId'],
        'missing-arg',
        '--bake <bakeDir>, --out <dir>, and --targets <a,b,...> are required',
      );
    }
    let targets: ExportTargetId[];
    try {
      targets = targetsRaw.split(',').map((t) =>
        parseWith(ExportTargetIdSchema, t.trim(), `target "${t.trim()}"`)
      );
    } catch (err) {
      return fail(
        'export' as JobEvent['jobId'],
        'unknown-target',
        err instanceof Error ? err.message : String(err),
      );
    }
    // the same arg-error-to-event discipline as the bake branch (M4): a bad
    // --fps must become an NDJSON error event, never a raw throw out of runCli
    try {
      return await pump(
        runExportJob({
          jobId: 'export',
          bakeDir,
          outDir: out,
          targets,
          fps: numFlag(args, 'fps', 8),
        }),
        emit,
      );
    } catch (err) {
      return fail(
        'export' as JobEvent['jobId'],
        'bad-args',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (verb !== 'undo' && verb !== 'redo') {
    return fail(
      'cli' as JobEvent['jobId'],
      'unknown-verb',
      `Unknown verb "${
        verb ?? ''
      }" - available: prep, gen, pick, retexture, rig, identity, clone, rename, models, anim, bake, export, doctor, undo, redo (--version)`,
    );
  }

  const manifestPath = flag(args, 'manifest');
  if (!manifestPath) {
    return fail('cli' as JobEvent['jobId'], 'missing-arg', '--manifest <path> is required');
  }

  const jobId = verb as JobEvent['jobId'];
  const f = files(manifestPath);
  emit({ t: 'queued', jobId, at: now() }, `${verb}: ${manifestPath}`);
  emit({ t: 'started', jobId, at: now() }, 'applying journal...');

  let state;
  try {
    state = await readJournal(f);
  } catch (err) {
    return fail(jobId, 'journal-read', err instanceof Error ? err.message : String(err));
  }

  try {
    if (verb === 'undo') {
      if (state.cursor === 0) return fail(jobId, 'nothing-to-undo', 'Nothing to undo');
      const patch = state.patches[state.cursor - 1];
      const next = applyPatchOps(state.doc, patch.inverse);
      const fault = manifestFault(next, f, `Undoing "${patch.label}"`);
      if (fault) return fail(jobId, 'invalid-manifest', fault);
      await Deno.writeTextFile(f.manifest, canonicalJson(next));
      await Deno.writeTextFile(f.cursor, String(state.cursor - 1));
      emit(
        { t: 'artifact', jobId, at: now(), kind: 'manifest', path: f.manifest },
        `undid: ${patch.label}`,
      );
    } else {
      if (state.cursor >= state.patches.length) {
        return fail(jobId, 'nothing-to-redo', 'Nothing to redo');
      }
      const patch = state.patches[state.cursor];
      const next = applyPatchOps(state.doc, patch.op);
      // redo has the same gap for the same reason: the forward ops came off
      // the same file the inverses did
      const fault = manifestFault(next, f, `Redoing "${patch.label}"`);
      if (fault) return fail(jobId, 'invalid-manifest', fault);
      await Deno.writeTextFile(f.manifest, canonicalJson(next));
      await Deno.writeTextFile(f.cursor, String(state.cursor + 1));
      emit(
        { t: 'artifact', jobId, at: now(), kind: 'manifest', path: f.manifest },
        `redid: ${patch.label}`,
      );
    }
  } catch (err) {
    return fail(jobId, 'patch-apply', err instanceof Error ? err.message : String(err));
  }

  emit({ t: 'done', jobId, at: now(), wallTimeS: 0 }, 'ok');
  return 0;
}

if (import.meta.main) {
  const code = await runCli(Deno.args, {
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
  });
  Deno.exit(code);
}
