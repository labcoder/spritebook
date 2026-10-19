declare module 'obj2gltf' {
  export default function obj2gltf(input: string, options: { binary: true }): Promise<Uint8Array>;
}

declare module 'draco3dgltf' {
  const draco: { createDecoderModule(): Promise<unknown> };
  export default draco;
}
