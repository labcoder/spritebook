/**
 * The component check exists to predict a rig ceiling from geometry alone, so
 * the two things it must get right are the false positive it nearly had (UV
 * seams and specks) and the true positive (a real second body).
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { connectedComponents, disconnectedWarning, SIGNIFICANT_FRACTION } from './components.ts';

/** A quad at x-offset `dx`, as 4 verts + 2 triangles appended to the buffers. */
function quad(pos: number[], idx: number[], dx: number, copies = 1): void {
  for (let c = 0; c < copies; c++) {
    const base = pos.length / 3;
    // a strip of `copies` quads sharing edges, so one call = one shell
    pos.push(dx + c, 0, 0, dx + c, 1, 0, dx + c + 1, 0, 0, dx + c + 1, 1, 0);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    if (c > 0) {
      // stitch to the previous quad by reusing its far edge positions
      idx.push(base - 2, base - 1, base, base - 1, base + 1, base);
    }
  }
}

Deno.test('a UV seam does not become a second component', () => {
  // THE false positive this was designed around: the border's weld merges
  // vertices identical in ALL attributes, so a texture seam legitimately
  // leaves two vertices at the same POINT. Walking raw indices would call one
  // shell two, and fire on every textured character.
  const pos: number[] = [];
  const idx: number[] = [];
  quad(pos, idx, 0);
  // duplicate vertex 2 at the same position, and build the second triangle
  // through the COPY - exactly what a seam split looks like in the buffer
  const dup = pos.length / 3;
  pos.push(pos[2 * 3], pos[2 * 3 + 1], pos[2 * 3 + 2]);
  idx.push(dup, 1, 3);
  const r = connectedComponents(Float32Array.from(pos), Uint32Array.from(idx));
  assertEquals(r.components.length, 1, 'the seam is welded away');
  assertEquals(disconnectedWarning(r), null);
});

Deno.test('one body plus specks is quiet; two bodies warn', () => {
  // Measured on the real subjects: bulma is 73 shells (largest 92.4%, next
  // 1.7%) and healthy; astro is 76 shells but its second is 20% and its rig
  // ceiling is real. The RAW count separates nothing - the significant one does.
  const pos: number[] = [];
  const idx: number[] = [];
  quad(pos, idx, 0, 20); // the body
  quad(pos, idx, 100); // a speck, far away
  const speckled = connectedComponents(Float32Array.from(pos), Uint32Array.from(idx));
  assert(speckled.components.length > 1, 'there really are two shells');
  assertEquals(speckled.significant.length, 1, 'but only one is substantial');
  assertEquals(disconnectedWarning(speckled), null, 'so it stays quiet');

  const two: number[] = [];
  const twoIdx: number[] = [];
  quad(two, twoIdx, 0, 10);
  quad(two, twoIdx, 100, 10); // a second body of comparable size
  const bodies = connectedComponents(Float32Array.from(two), Uint32Array.from(twoIdx));
  assertEquals(bodies.significant.length, 2);
  const w = disconnectedWarning(bodies);
  assert(w, 'two bodies must warn');
  assert(w.includes('SUBSTANTIAL'), w);
  assert(w.includes('no joint placement or hint can repair') || w.includes('hint can repair'), w);
});

Deno.test('the significance threshold is the documented one', () => {
  // pinned because the constant is argued from three subjects, not derived:
  // it sits between the largest decoration seen (4.0%) and the smallest real
  // second body (20.0%). Moving it should be a deliberate, visible change.
  assertEquals(SIGNIFICANT_FRACTION, 0.1);
});

Deno.test('an empty mesh reports nothing rather than dividing by zero', () => {
  const r = connectedComponents(new Float32Array(), new Uint32Array());
  assertEquals(r.components.length, 0);
  assertEquals(r.weldedVertices, 0);
  assertEquals(disconnectedWarning(r), null);
});
