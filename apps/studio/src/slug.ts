/**
 * characterId minting: display name -> slug preview. The RULE is core's
 * (packages/schema CharacterIdSchema: /^[a-z0-9][a-z0-9-]{1,40}$/) — this
 * mirrors it for live preview, and slug_test.ts cross-checks every sample
 * against the actual schema so the two can never drift silently.
 */

export const CHARACTER_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41);
}

/** null = valid; otherwise the one honest sentence for the field hint. */
export function slugProblem(slug: string): string | null {
  if (slug.length === 0) return 'a name is required';
  if (slug.length < 2) return 'ids need at least 2 characters';
  if (!CHARACTER_ID_RE.test(slug)) return 'ids are lowercase letters, digits and dashes';
  return null;
}
