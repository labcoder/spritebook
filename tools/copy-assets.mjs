import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../packages/', import.meta.url));
for (
  const [name, assets] of [
    ['registry', ['catalog']],
    ['render', ['shaders.wgsl']],
    ['anim', ['packs']],
    ['rig', ['bodies']],
  ]
) {
  await mkdir(`${root}/${name}/dist`, { recursive: true });
  for (const asset of assets) {
    await cp(`${root}/${name}/${asset}`, `${root}/${name}/dist/${asset}`, {
      recursive: true,
    });
  }
}
