import { canonicalJson, type LicenseInfo } from '@spritebook/schema';
/**
 * Streaming sha256 (D-009): checkpoints are GB-scale, so hashing must never
 * buffer a whole file. Node's file stream feeds the digest at O(chunk) memory.
 * Install and verify share this ONE code path — the trust anchor is the hash,
 * never the download source (sidecar-vram skill).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Lowercase hex of a digest buffer. */
export function digestHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 of a file on disk, streamed chunk by chunk — never whole-file. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function licenseFingerprint(license: LicenseInfo): Promise<string> {
  return digestHex(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(license))),
  );
}
