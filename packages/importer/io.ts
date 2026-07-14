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

export const IMPORTER_VERSION = '0.1.0';
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

/** Serialize the canonical document: fixed generator, no volatile fields. */
export async function writeCanonical(doc: Document): Promise<Uint8Array> {
  const io = await getIO();
  const asset = doc.getRoot().getAsset();
  asset.generator = GENERATOR;
  delete asset.copyright;
  return await io.writeBinary(doc);
}
