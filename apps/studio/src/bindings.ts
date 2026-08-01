/**
 * The binding grammar and the frames math — pure, react-free, so the Deno
 * suite holds them (anim_test.ts) and the surface just renders them.
 */

export interface BindingLike {
  clipId: string;
  enabled?: boolean;
  frames: number;
  speed: number;
  holdLast: boolean;
}

/** clip:frames[@speed][!hold] — the bake/enable grammar, one builder. */
export function bindingSpec(b: BindingLike): string {
  return `${b.clipId}:${b.frames}${b.speed !== 1 ? `@${b.speed}` : ''}${b.holdLast ? '!hold' : ''}`;
}

/** The visible cost: enabled clips × directions × their frames. */
export function framesMath(bindings: BindingLike[], directions: number): {
  clips: number;
  directions: number;
  meanFrames: number;
  total: number;
} {
  const enabled = bindings.filter((b) => b.enabled === true);
  const frames = enabled.reduce((a, b) => a + b.frames, 0);
  return {
    clips: enabled.length,
    directions,
    meanFrames: enabled.length > 0 ? frames / enabled.length : 0,
    total: frames * directions,
  };
}
