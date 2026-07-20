/**
 * Streaming sha256 (D-009): checkpoints are GB-scale, so hashing must never
 * buffer a whole file. std/crypto's digest consumes an async iterable of
 * chunks, and a Deno file's readable stream feeds it at O(chunk) memory.
 * Install and verify share this ONE code path — the trust anchor is the hash,
 * never the download source (sidecar-vram skill).
 */
import { crypto } from '@std/crypto';

/** Lowercase hex of a digest buffer. */
export function digestHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 of a file on disk, streamed chunk by chunk — never whole-file. */
export async function hashFile(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  try {
    return digestHex(await crypto.subtle.digest('SHA-256', file.readable));
  } catch (err) {
    // fully consuming the stream closes the fd; only a mid-read throw leaves it open
    try {
      file.close();
    } catch {
      // already closed by the consumed stream
    }
    throw err;
  }
}
