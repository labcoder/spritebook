declare module 'pixelmatch' {
  export default function pixelmatch(a: Uint8Array, b: Uint8Array, output: Uint8Array, width: number, height: number, options?: { threshold?: number }): number;
}
