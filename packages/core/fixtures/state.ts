import { appendGenerationResult } from '../dist/receipts.js';
export async function append(workspace: string, id: string, hash = 'a'.repeat(64)) {
  await appendGenerationResult(workspace, {
    id,
    backend: { modelId: 'fixture-gen', version: '1' },
    params: {},
    seed: 7,
    startedAt: '2026-10-19T00:00:00Z',
    wallTimeS: 0,
    output: { gltfSha256: hash, tris: 1, kind: 'mesh' },
    discarded: false,
  });
}
