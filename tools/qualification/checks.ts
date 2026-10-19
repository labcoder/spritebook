// Carry the original assertions across runtimes rather than rewriting their expectations.
import { getGpu } from '../../packages/render/gpu.ts';

const tests: { name: string; fn: (context: Deno.TestContext) => unknown; ignore?: boolean }[] = [];
// This runner intentionally lacks Deno's resource sanitizer; qualify lifetimes separately.
Object.defineProperty(Deno, 'test', {
  value: (name: string | (typeof tests)[number], fn: (typeof tests)[number]['fn']) => {
    tests.push(typeof name === 'string' ? { name, fn } : name);
  },
});

await import('../../packages/render/render_test.ts');
await import('../../packages/render/material_test.ts');
await import('../../packages/render/lighting_test.ts');
await import('../../packages/render/attachment_test.ts');
await import('../../packages/render/camera_test.ts');
await import('../../packages/render/skinning_test.ts');
await import('../../packages/render/placement_test.ts');
await import('../../packages/render/poses_test.ts');
await import('../../packages/anim/profile_test.ts');
await import('../../packages/anim/retarget_test.ts');
await import('../../packages/style/pipeline_test.ts');
await import('../../packages/style/goldens_test.ts');
await import('../../packages/pack/contactsheet_test.ts');
await import('../../packages/pack/atlas_test.ts');
await import('../../packages/pack/mirror_test.ts');

let passed = 0;
try {
  for (const test of tests) {
    if (test.ignore) throw new Error(`Qualification cannot skip ${test.name}`);
    const context = {
      step: async (name: string, fn: () => unknown) => {
        await fn();
        console.log(JSON.stringify({ t: 'step', name }));
        return true;
      },
    } as Deno.TestContext;
    await test.fn(context);
    passed++;
    console.log(JSON.stringify({ t: 'check', name: test.name }));
  }
  console.log(JSON.stringify({ t: 'checks-done', passed }));
} finally {
  (await getGpu()).device.destroy();
}
