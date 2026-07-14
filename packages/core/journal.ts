/**
 * Manifest journal (law 7): every mutation is a journaled, reversible
 * ManifestPatch with a PRECOMPUTED inverse. `undo` replays inverses verbatim
 * (never recomputes); `redo` replays forward ops. Backing store for the
 * `spritebook undo`/`redo` verbs.
 *
 * Patch semantics: RFC-6902 subset (add | remove | replace) over JSON
 * Pointers, including `~0`/`~1` unescaping and the array `-` append form.
 */
import type { JsonPatchOp, ManifestPatch } from '@spritebook/schema';
import { canonicalJson, ManifestPatchSchema, parseWith } from '@spritebook/schema';

type Doc = Record<string, unknown>;

// ---------------------------------------------------------------------------
// JSON Pointer (RFC 6901)
// ---------------------------------------------------------------------------

function segments(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`invalid JSON Pointer: "${path}"`);
  return path.slice(1).split('/').map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));
}

interface Site {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
}

/** Resolve the CONTAINER of the pointer target (last segment = key). */
function locate(doc: Doc, path: string, opForArray: 'add' | 'other'): Site {
  const segs = segments(path);
  if (segs.length === 0) throw new Error('the root document cannot be patched directly');
  let node: unknown = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    node = child(node, segs[i], path);
  }
  const last = segs[segs.length - 1];
  if (Array.isArray(node)) {
    if (last === '-') {
      if (opForArray !== 'add') throw new Error(`"-" is only valid for add: "${path}"`);
      return { parent: node, key: node.length };
    }
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || String(idx) !== last) {
      throw new Error(`invalid array index "${last}" in "${path}"`);
    }
    const max = opForArray === 'add' ? node.length : node.length - 1;
    if (idx > max) throw new Error(`array index ${idx} out of range in "${path}"`);
    return { parent: node, key: idx };
  }
  if (node !== null && typeof node === 'object') {
    return { parent: node as Record<string, unknown>, key: last };
  }
  throw new Error(`cannot descend into non-object at "${path}"`);
}

function child(node: unknown, seg: string, path: string): unknown {
  if (Array.isArray(node)) {
    const idx = Number(seg);
    if (!Number.isInteger(idx) || String(idx) !== seg || idx < 0 || idx >= node.length) {
      throw new Error(`invalid array index "${seg}" in "${path}"`);
    }
    return node[idx];
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (!(seg in obj)) throw new Error(`path segment "${seg}" not found in "${path}"`);
    return obj[seg];
  }
  throw new Error(`cannot descend into non-object at "${path}"`);
}

function has(site: Site): boolean {
  return Array.isArray(site.parent)
    ? (site.key as number) < site.parent.length
    : (site.key as string) in site.parent;
}

function read(site: Site): unknown {
  return Array.isArray(site.parent)
    ? site.parent[site.key as number]
    : site.parent[site.key as string];
}

/** Apply one op in place. Returns nothing; throws with the offending path. */
function applyOp(doc: Doc, op: JsonPatchOp): void {
  const site = locate(doc, op.path, op.op === 'add' ? 'add' : 'other');
  if (op.op === 'add') {
    if (Array.isArray(site.parent)) {
      site.parent.splice(site.key as number, 0, structuredClone(op.value));
    } else {
      site.parent[site.key as string] = structuredClone(op.value);
    }
    return;
  }
  if (!has(site)) throw new Error(`${op.op}: nothing exists at "${op.path}"`);
  if (op.op === 'remove') {
    if (Array.isArray(site.parent)) site.parent.splice(site.key as number, 1);
    else delete site.parent[site.key as string];
    return;
  }
  // replace
  if (Array.isArray(site.parent)) site.parent[site.key as number] = structuredClone(op.value);
  else site.parent[site.key as string] = structuredClone(op.value);
}

/** Compute the exact inverse of one op against the CURRENT document state. */
function invertOp(doc: Doc, op: JsonPatchOp): JsonPatchOp {
  if (op.op === 'add') {
    // inverse of add = remove at the concrete index ('-' resolved now)
    const site = locate(doc, op.path, 'add');
    const concrete = Array.isArray(site.parent) && op.path.endsWith('/-')
      ? op.path.slice(0, -2) + '/' + String(site.key)
      : op.path;
    return { op: 'remove', path: concrete };
  }
  const site = locate(doc, op.path, 'other');
  if (!has(site)) throw new Error(`${op.op}: nothing exists at "${op.path}"`);
  const previous = structuredClone(read(site));
  return op.op === 'remove'
    ? { op: 'add', path: op.path, value: previous }
    : { op: 'replace', path: op.path, value: previous };
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export interface CommitInput {
  target: ManifestPatch['target'];
  op: JsonPatchOp[];
  label: string;
}

export class ManifestJournal {
  #doc: Doc;
  #undo: ManifestPatch[] = [];
  #redo: ManifestPatch[] = [];
  #seq = 0;
  #now: () => string;

  constructor(doc: Doc, opts: { now?: () => string } = {}) {
    this.#doc = structuredClone(doc);
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  /** Current document (defensive copy). */
  get doc(): Doc {
    return structuredClone(this.#doc);
  }

  get canonicalBytes(): string {
    return canonicalJson(this.#doc);
  }

  get undoDepth(): number {
    return this.#undo.length;
  }

  get redoDepth(): number {
    return this.#redo.length;
  }

  /**
   * Build a ManifestPatch (inverse PRECOMPUTED against the live document,
   * audit 7), validate it, apply it, and journal it. A new commit clears the
   * redo stack. All-or-nothing: a failing op leaves the document untouched.
   */
  commit(input: CommitInput): ManifestPatch {
    const work = structuredClone(this.#doc);
    const inverse: JsonPatchOp[] = [];
    for (const op of input.op) {
      inverse.unshift(invertOp(work, op)); // inverse replays in reverse order
      applyOp(work, op);
    }
    const patch = parseWith(ManifestPatchSchema, {
      seq: this.#seq,
      at: this.#now(),
      target: input.target,
      op: input.op,
      inverse,
      label: input.label,
    }, 'ManifestPatch');
    this.#doc = work;
    this.#seq++;
    this.#undo.push(patch);
    this.#redo = [];
    return patch;
  }

  /** Replay a persisted patch (forward). Used when loading a journal file. */
  replay(patch: ManifestPatch): void {
    const valid = parseWith(ManifestPatchSchema, patch, 'ManifestPatch');
    const work = structuredClone(this.#doc);
    for (const op of valid.op) applyOp(work, op);
    this.#doc = work;
    this.#seq = Math.max(this.#seq, valid.seq + 1);
    this.#undo.push(valid);
    this.#redo = [];
  }

  /** Undo the most recent patch by replaying its precomputed inverse. */
  undo(): ManifestPatch | undefined {
    const patch = this.#undo.pop();
    if (!patch) return undefined;
    const work = structuredClone(this.#doc);
    for (const op of patch.inverse) applyOp(work, op);
    this.#doc = work;
    this.#redo.push(patch);
    return patch;
  }

  /** Redo the most recently undone patch by replaying its forward ops. */
  redo(): ManifestPatch | undefined {
    const patch = this.#redo.pop();
    if (!patch) return undefined;
    const work = structuredClone(this.#doc);
    for (const op of patch.op) applyOp(work, op);
    this.#doc = work;
    this.#undo.push(patch);
    return patch;
  }
}

/** Apply a patch's forward ops to a plain document (pure helper). */
export function applyPatchOps(doc: Doc, ops: JsonPatchOp[]): Doc {
  const work = structuredClone(doc);
  for (const op of ops) applyOp(work, op);
  return work;
}
