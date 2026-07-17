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
 * Export `<characterId>.tres` + the lit pages into outDir; returns the written
 * paths, sorted. Throws (never writes garbage) on manifests this projection
 * cannot represent: no lit pages, no frames, dangling page references,
 * duplicate page indices, unsafe clip ids, or a non-positive fps.
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
    lines.push(
      `[sub_resource type="AtlasTexture" id="AtlasTexture_${i + 1}"]`,
      `atlas = ExtResource("${extId}")`,
      `region = Rect2(${f.atlas.x}, ${f.atlas.y}, ${f.atlas.w}, ${f.atlas.h})`,
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
  lines.push('[resource]', 'animations = [{');
  for (const [gi, g] of groups.entries()) {
    lines.push('"frames": [{');
    for (const [j, subIndex] of g.subIndices.entries()) {
      lines.push('"duration": 1.0,', `"texture": SubResource("AtlasTexture_${subIndex + 1}")`);
      lines.push(j < g.subIndices.length - 1 ? '}, {' : '}],');
    }
    lines.push('"loop": true,', `"name": &"${g.clipId}_d${pad2(g.direction)}",`);
    lines.push(`"speed": ${godotFloat(opts.fps)}`);
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
