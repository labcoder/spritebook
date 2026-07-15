/** Shared golden config so the generator and the test agree on frames + names. */

/** (direction, frame) pairs golden-tested per preset: bind pose + a mid-idle frame. */
export const GOLDEN_FRAMES: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, 3]];

export function goldenName(preset: string, direction: number, frame: number): string {
  const d = String(direction).padStart(2, '0');
  const f = String(frame).padStart(3, '0');
  return `styled-${preset}-d${d}-f${f}.png`;
}
