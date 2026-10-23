import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';

/** Preserve the canonical GLB verbatim; also expose its embedded texture bytes. */
export async function exportModel(modelPath: string, outDir: string): Promise<void> {
  const target = resolve(outDir, 'model.glb');
  if (target === resolve(modelPath)) throw new Error('Model export cannot overwrite its input');
  const bytes = new Uint8Array(await fs.readFile(modelPath));
  const doc = await new NodeIO().readBinary(bytes);
  const textures = doc.getRoot().listTextures().map((texture, index) => {
    const mime = texture.getMimeType();
    const extensions: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/ktx2': 'ktx2',
    };
    const extension = extensions[mime];
    const image = texture.getImage();
    if (!extension || !image) {
      throw new Error(`Cannot export texture ${index}: missing image or unsupported MIME ${mime}`);
    }
    return {
      file: `texture-${String(index).padStart(2, '0')}.${extension}`,
      name: texture.getName(),
      mime,
      image,
    };
  });
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(target, bytes);
  for (const texture of textures) await fs.writeFile(resolve(outDir, texture.file), texture.image);
  await fs.writeFile(
    resolve(outDir, 'textures.json'),
    JSON.stringify(
      {
        model: 'model.glb',
        embeddedTextures: true,
        textures: textures.map(({ file, name, mime }) => ({ file, name, mime })),
      },
      null,
      2,
    ) + '\n',
  );
}
