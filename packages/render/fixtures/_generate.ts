/**
 * Render fixture generator (deterministic; run once, the glb is checked in):
 *  - skinned-column.glb   the hermetic P0-T2 spike asset (procedural, rigged,
 *                         one skin / multi-joint chain) — small, draws in ms,
 *                         and is what the WebGPU spike already validated.
 *
 * The golden-testing skill wants a tiny rigged fixture, not a production
 * character; this is that. A deliberately asymmetric rigged fixture joins when
 * the mirroring tests land with the packer (P2-T3).
 *
 *   deno run --allow-read --allow-write packages/render/fixtures/_generate.ts
 */
const here = new URL('.', import.meta.url);
const src = new URL('../../../spikes/webgpu/assets/skinned-column.glb', here);
await Deno.writeFile(new URL('skinned-column.glb', here), await Deno.readFile(src));
console.log('render fixtures written: skinned-column.glb');
