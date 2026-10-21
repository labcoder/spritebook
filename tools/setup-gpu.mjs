import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractArchive } from './archive.ts';

export const VULKAN_VERSION = '1.4.341.0';
const ARCHIVE_HASH = '20571dcc8292b80a47d68bbbfa4094d87044041f50f4e2e1f326a01e3732b226';
const LOADER_HASH = '98bc6e33b384f83e8cc36174ce1ba81357611d0cbe03462e1ca58d0663034039';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Dawn's qualified Windows Vulkan loader must sit beside dawn.node (D-049). */
export async function installVulkan(target) {
  assert(
    process.platform === 'win32' && process.arch === 'x64',
    'Windows x64 loader only',
  );
  const cache = fileURLToPath(new URL('../.build/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const zipPath = join(cache, `vulkan-${VULKAN_VERSION}.zip`);
  let zip = await readFile(zipPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!zip) {
    const response = await fetch(
      `https://sdk.lunarg.com/sdk/download/${VULKAN_VERSION}/windows/VulkanRT-X64-${VULKAN_VERSION}-Components.zip?Human=true`,
    );
    assert(response.ok, `Vulkan loader: HTTP ${response.status}`);
    zip = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha(zip), ARCHIVE_HASH, 'Vulkan archive checksum');
    await writeFile(zipPath, zip);
  }
  assert.equal(sha(zip), ARCHIVE_HASH, 'cached Vulkan archive checksum');
  const temp = await mkdtemp(join(tmpdir(), 'spritebook-vulkan-'));
  try {
    extractArchive(zipPath, temp);
    const root = join(temp, `VulkanRT-X64-${VULKAN_VERSION}-Components`);
    assert.equal(
      sha(await readFile(join(root, 'x64/vulkan-1.dll'))),
      LOADER_HASH,
      'Vulkan loader checksum',
    );
    await mkdir(target, { recursive: true });
    await copyFile(
      join(root, 'x64/vulkan-1.dll'),
      join(target, 'vulkan-1.dll'),
    );
    await copyFile(
      join(root, 'VulkanRT-License.txt'),
      join(target, 'VulkanRT-License.txt'),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  process.platform === 'win32'
) {
  const addon = dirname(fileURLToPath(import.meta.resolve('webgpu')));
  await installVulkan(join(addon, 'dist', `win32-${process.arch}`));
}
