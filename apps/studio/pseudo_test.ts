/**
 * Hard commitment 3's number, held: the pseudo locale expands EVERY string
 * by at least 40%, visibly bracketed so truncation is unmissable.
 */
import { assert } from 'jsr:@std/assert@1';
import { pseudoExpand } from './src/pseudo.ts';

Deno.test('every string grows >= 40% and is bracketed', () => {
  const samples = [
    'Gallery',
    'Run health exam',
    'Projects root',
    'locked until a canonical mesh is saved',
    'log',
    'a', // the degenerate short case still grows
    'nearest-neighbor · integer zoom · core output',
  ];
  for (const s of samples) {
    const p = pseudoExpand(s);
    assert(p.startsWith('⟦') && p.endsWith('⟧'), `bracketed: ${p}`);
    const inner = p.slice(1, -1);
    assert(
      inner.length >= Math.ceil(s.length * 1.4),
      `"${s}" (${s.length}) grew to ${inner.length}, wanted >= ${Math.ceil(s.length * 1.4)}`,
    );
  }
});

Deno.test('accents land, so non-ASCII rendering problems surface in dev', () => {
  const p = pseudoExpand('bake sheet');
  assert(/[áéíóúýñç]/i.test(p), `accented: ${p}`);
});
