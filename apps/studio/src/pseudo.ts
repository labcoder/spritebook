/**
 * The pseudo-locale transform (design-system hard commitment 3): every UI
 * string expands by at least 40% with accented characters, so a layout that
 * survives the pseudo locale survives real localization. Pure and
 * dependency-free so the Node suite can hold the +40% guarantee.
 */

const ACCENTS: Record<string, string> = {
  a: 'á',
  e: 'é',
  i: 'í',
  o: 'ó',
  u: 'ú',
  y: 'ý',
  n: 'ñ',
  c: 'ç',
  A: 'Å',
  E: 'É',
  I: 'Î',
  O: 'Ø',
  U: 'Ü',
  N: 'Ñ',
  C: 'Ç',
};

export function pseudoExpand(id: string): string {
  const accented = [...id].map((ch) => ACCENTS[ch] ?? ch).join('');
  // pad to >= 1.4x the source length, in visible chunks so truncation shows
  const target = Math.ceil(id.length * 1.4);
  let out = accented;
  while (out.length < target) {
    out += ' ·×·'.slice(0, Math.min(4, target - out.length));
  }
  return `⟦${out}⟧`;
}
