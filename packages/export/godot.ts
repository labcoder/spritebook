/**
 * Godot 4 SpriteFrames exporter — a PURE PROJECTION of BakeManifest (D-010).
 *
 * Emits one `<characterId>.tres` (text resource, format=3, NO uid — Godot
 * assigns uids on import; omitting keeps the bytes stable) plus verbatim
 * copies of the lit atlas pages, which the resource references by relative
 * path. Deterministic construction: ext_resource ids are "1","2",... in lit
 * page order; sub_resource ids are "AtlasTexture_1",... in canonical frame
 * order (clipId, direction, frame); one animation per (clipId, direction)
 * named `<clipId>_d<DD>`. Never reads the clock, never projects volatile
 * fields (byte-stability doctrine, packages/pack/contracts.ts).
 *
 * PIVOT: every frame's `margin` re-centres its AtlasTexture on the recorded
 * `pivotPx`, so `AnimatedSprite2D.centered` — TRUE by default — anchors the
 * node origin on the character's feet rather than the middle of the cell. See
 * pivotMargin() for the Godot 4 semantics this leans on. SpriteFrames is a
 * Resource, so it cannot carry the node-level `offset`/`centered` that would
 * be the other way to say this; baking the pivot into each AtlasTexture keeps
 * the .tres self-contained (drop it on any AnimatedSprite2D and it is right)
 * and is PER FRAME, so a bake whose pivot differs per direction still lands.
 *
 * TIMING: each animation's `loop` and `speed` come from that clip's entry in
 * `BakeManifest.clips`, so a `!hold` death clip stops on its last frame and
 * clips of different lengths keep their own rates. `clips` is optional; a bake
 * without it falls back to opts.fps and an endless loop.
 */
import type { FrameRecord } from '@spritebook/schema';
import { atlasPageName, type Exporter, frameIdKey } from '../pack/contracts.ts';

/** The schema leaves clipId free-form; resource names and file names must not. */
const SAFE_CLIP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Canonical frame order (clipId, direction, frame); code-unit compare, locale-free. */
function compareFrames(a: FrameRecord, b: FrameRecord): number {
  if (a.clipId !== b.clipId) return a.clipId < b.clipId ? -1 : 1;
  return a.direction - b.direction || a.frame - b.frame;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Godot float literal: always at least one decimal (8 -> '8.0', 8.5 -> '8.5'). */
function godotFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

/**
 * The `AtlasTexture.margin` that moves a frame's ANCHOR onto its recorded
 * pivot, given the cell extent `size` and the pivot coordinate `pivot` on one
 * axis (both in px, cell-local).
 *
 * Godot 4 (scene/resources/atlas_texture.cpp): an AtlasTexture reports
 * `region.size + margin.size` as its size and draws the region `margin.position`
 * inside that box. AnimatedSprite2D draws the whole reported size at `-size/2`
 * when `centered` (its default), so the cell pixel at `pivot` lands at
 *   margin.position + pivot - (region.size + margin.size) / 2
 * and the node origin sits on the pivot exactly when that is zero. Padding the
 * side AWAY from the pivot by twice its distance from the centre solves it:
 * `size - 2*pivot` px of leading pad when the pivot is above/left of centre,
 * `2*pivot - size` px of trailing pad otherwise. The pad is transparent — it
 * enlarges the drawn quad, never the atlas page, and never the sampled region
 * (position <= size keeps the region strictly inside the box, so no pixel is
 * clipped). For an integer pivot the box is even-sized, so the sprite still
 * lands on whole pixels.
 */
function pivotMargin(size: number, pivot: number): { position: number; size: number } {
  const lead = size - 2 * pivot;
  return { position: Math.max(0, lead), size: Math.abs(lead) };
}

/**
 * Export `<characterId>.tres` + the lit pages into outDir; returns the written
 * paths, sorted. Throws (never writes garbage) on manifests this projection
 * cannot represent: no lit pages, no frames, dangling page references,
 * duplicate page indices, unsafe clip ids, a non-finite pivot, or a
 * non-positive fps.
 */
export const exportGodot: Exporter = async (manifest, bakeDir, outDir, opts) => {
  if (!Number.isFinite(opts.fps) || opts.fps <= 0) {
    throw new Error(`exportGodot: fps must be a finite number > 0, got ${opts.fps}`);
  }
  const litPages = manifest.atlases
    .filter((p) => p.pass === 'lit')
    .sort((a, b) => a.pageIndex - b.pageIndex);
  if (litPages.length === 0) throw new Error('exportGodot: manifest has no lit atlas pages');
  const frames = [...manifest.frames].sort(compareFrames);
  if (frames.length === 0) throw new Error('exportGodot: manifest has no frames');

  const extIdByPage = new Map<number, string>();
  for (const [i, page] of litPages.entries()) {
    if (extIdByPage.has(page.pageIndex)) {
      throw new Error(`exportGodot: duplicate lit atlas pageIndex ${page.pageIndex}`);
    }
    extIdByPage.set(page.pageIndex, String(i + 1));
  }

  const lines: string[] = [];
  const loadSteps = litPages.length + frames.length + 1;
  lines.push(`[gd_resource type="SpriteFrames" load_steps=${loadSteps} format=3]`, '');
  for (const [i, page] of litPages.entries()) {
    const path = atlasPageName('lit', page.pageIndex);
    lines.push(`[ext_resource type="Texture2D" path="${path}" id="${i + 1}"]`);
  }
  lines.push('');
  for (const [i, f] of frames.entries()) {
    if (!SAFE_CLIP_ID.test(f.clipId)) {
      throw new Error(`exportGodot: clipId '${f.clipId}' is not resource-name safe`);
    }
    const extId = extIdByPage.get(f.atlas.pageIndex);
    if (extId === undefined) {
      throw new Error(
        `exportGodot: frame ${frameIdKey(f)} references atlas page ${f.atlas.pageIndex}, ` +
          'which has no lit page in the manifest',
      );
    }
    if (!Number.isFinite(f.pivotPx.x) || !Number.isFinite(f.pivotPx.y)) {
      throw new Error(
        `exportGodot: frame ${frameIdKey(f)} has a non-finite pivot ` +
          `(${f.pivotPx.x}, ${f.pivotPx.y})`,
      );
    }
    const mx = pivotMargin(f.atlas.w, f.pivotPx.x);
    const my = pivotMargin(f.atlas.h, f.pivotPx.y);
    lines.push(
      `[sub_resource type="AtlasTexture" id="AtlasTexture_${i + 1}"]`,
      `atlas = ExtResource("${extId}")`,
      `region = Rect2(${f.atlas.x}, ${f.atlas.y}, ${f.atlas.w}, ${f.atlas.h})`,
      `margin = Rect2(${mx.position}, ${my.position}, ${mx.size}, ${my.size})`,
      '',
    );
  }

  // one animation per (clipId, direction) — groups are contiguous in canonical order
  const groups: Array<{ clipId: string; direction: number; subIndices: number[] }> = [];
  for (const [i, f] of frames.entries()) {
    const last = groups.at(-1);
    if (last !== undefined && last.clipId === f.clipId && last.direction === f.direction) {
      last.subIndices.push(i);
    } else {
      groups.push({ clipId: f.clipId, direction: f.direction, subIndices: [i] });
    }
  }
  // Per-clip timing when the bake recorded it. `clips` is optional — a legacy
  // idle bake has none — so an absent clip keeps the old behaviour: opts.fps
  // and an endless loop. ClipTiming.fps is schema-guaranteed finite-positive.
  const timingByClip = new Map((manifest.clips ?? []).map((c) => [c.clipId, c]));

  lines.push('[resource]', 'animations = [{');
  for (const [gi, g] of groups.entries()) {
    lines.push('"frames": [{');
    for (const [j, subIndex] of g.subIndices.entries()) {
      lines.push('"duration": 1.0,', `"texture": SubResource("AtlasTexture_${subIndex + 1}")`);
      lines.push(j < g.subIndices.length - 1 ? '}, {' : '}],');
    }
    const timing = timingByClip.get(g.clipId);
    lines.push(
      `"loop": ${timing?.loop ?? true},`,
      `"name": &"${g.clipId}_d${pad2(g.direction)}",`,
    );
    lines.push(`"speed": ${godotFloat(timing?.fps ?? opts.fps)}`);
    lines.push(gi < groups.length - 1 ? '}, {' : '}]');
  }

  await Deno.mkdir(outDir, { recursive: true });
  const tresPath = `${outDir}/${manifest.characterId}.tres`;
  await Deno.writeTextFile(tresPath, lines.join('\n') + '\n');
  const written = [tresPath];
  for (const page of litPages) {
    const dest = `${outDir}/${atlasPageName('lit', page.pageIndex)}`;
    await Deno.copyFile(`${bakeDir}/${page.png}`, dest);
    written.push(dest);
  }
  return written.sort();
};
