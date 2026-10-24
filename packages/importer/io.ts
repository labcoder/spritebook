/**
 * glTF-Transform I/O, configured once per the skill: ALL extensions and both
 * decoders registered up front — user files arrive Draco/meshopt-compressed
 * constantly, and reads fail without them. Canonical writes go through
 * writeCanonical (fixed generator string, deterministic bytes).
 */
import { type Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';

export const IMPORTER_VERSION = '0.1.1';
export const GENERATOR = `spritebook-import@${IMPORTER_VERSION}`;

let ioPromise: Promise<NodeIO> | undefined;

export function getIO(): Promise<NodeIO> {
  ioPromise ??= (async () => {
    await MeshoptDecoder.ready;
    return new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'meshopt.decoder': MeshoptDecoder,
      });
  })();
  return ioPromise;
}

/**
 * Rewrite a .glb's `asset.generator` in the serialized bytes.
 *
 * glTF-Transform's writer stamps its OWN generator over whatever the Document
 * carried, so setting it before `writeBinary` is silently undone — every
 * canonical asset claimed to be made by glTF-Transform from P1-T4 until this
 * was caught by the P3-T2 generation acceptance (the double-import
 * determinism test could never see it: both sides got the same wrong string).
 * The container is rebuilt exactly: JSON chunk padded with spaces, BIN chunk
 * left byte-identical, header lengths recomputed. Deterministic in, out.
 */
function stampGenerator(bytes: Uint8Array, generator: string): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = view.getUint32(12, true);
  const jsonStart = 20; // 12-byte header + 8-byte chunk header
  const doc = JSON.parse(
    new TextDecoder().decode(bytes.subarray(jsonStart, jsonStart + jsonLen)),
  );
  doc.asset = { ...doc.asset, generator };
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const jsonPad = (4 - (json.length % 4)) % 4;
  const rest = bytes.subarray(jsonStart + jsonLen); // BIN chunk, untouched
  const total = 12 + 8 + json.length + jsonPad + rest.length;

  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);
  out.set(bytes.subarray(0, 12), 0); // magic + version (length fixed below)
  outView.setUint32(8, total, true);
  outView.setUint32(12, json.length + jsonPad, true);
  outView.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(json, jsonStart);
  out.fill(0x20, jsonStart + json.length, jsonStart + json.length + jsonPad);
  out.set(rest, jsonStart + json.length + jsonPad);
  return out;
}

/** Serialize the canonical document: fixed generator, no volatile fields. */
export async function writeCanonical(doc: Document): Promise<Uint8Array> {
  const io = await getIO();
  const asset = doc.getRoot().getAsset();
  asset.generator = GENERATOR;
  delete asset.copyright;
  // the writer overwrites asset.generator, so the stamp goes on afterwards
  return stampGenerator(await io.writeBinary(doc), GENERATOR);
}
