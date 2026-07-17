/**
 * Per-page JSON formats (Aseprite array, TexturePacker hash) emit one document
 * per lit atlas page, so an animation — a (clipId, direction) frame run — that
 * straddles pages would be silently TRUNCATED in each document (adversarial
 * review M1: a consumer loads one JSON and plays a partial animation, or loads
 * both and collides on the tag name). Godot (all pages in one .tres) and strips
 * (per-frame crops) are immune. Mirroring the strips exporter's non-uniform-cell
 * guard: refuse loudly instead of projecting a lie.
 */
import type { BakeManifest } from '@spritebook/schema';

export function assertNoSplitAnimations(manifest: BakeManifest, format: string): void {
  const pagesByGroup = new Map<string, Set<number>>();
  for (const f of manifest.frames) {
    const group = `${f.clipId}_d${String(f.direction).padStart(2, '0')}`;
    let pages = pagesByGroup.get(group);
    if (!pages) pagesByGroup.set(group, pages = new Set());
    pages.add(f.atlas.pageIndex);
  }
  for (const [group, pages] of pagesByGroup) {
    if (pages.size > 1) {
      throw new Error(
        `${format}: animation "${group}" spans atlas pages ${[...pages].sort().join(', ')} - ` +
          `a per-page JSON would truncate it. Rebake with a larger page budget or fewer/smaller ` +
          `cells, or export godot/strips (both handle multi-page bakes).`,
      );
    }
  }
}
