/**
 * The stage rail's truth: six pipeline stages projected from a character
 * manifest, read-only. The lock law comes from the design system — stages
 * 02–06 are LOCKED until a canonical mesh is saved, and the rail states the
 * unlock condition instead of hiding it. Pure so the Node suite pins it.
 */

export type StageKey = 'gen' | 'rig' | 'anim' | 'look' | 'bake' | 'export';
export type StageState = 'done' | 'warn' | 'idle' | 'locked';

export interface Stage {
  key: StageKey;
  /** two-digit rail index, '01'…'06' */
  n: string;
  /** semantic token carrying the stage hue (the Marathon move) */
  hueVar: string;
  state: StageState;
  /** one honest line: what is recorded, or what unlocks it */
  note: string;
}

function has(v: unknown): boolean {
  return v !== undefined && v !== null;
}

export function stageStates(manifest: unknown): Stage[] {
  const m = (manifest !== null && typeof manifest === 'object' ? manifest : {}) as Record<
    string,
    unknown
  >;
  const gen = (m.generation ?? {}) as Record<string, unknown>;
  const rig = m.rig as Record<string, unknown> | undefined;
  const look = (m.look ?? {}) as Record<string, unknown>;
  const canonical = has(m.canonicalMesh);
  const results = Array.isArray(gen.results) ? gen.results.length : 0;
  const picked = typeof gen.pickedResultId === 'string' ? gen.pickedResultId : undefined;
  const clips = Array.isArray(m.animationSet)
    ? (m.animationSet as { enabled?: boolean }[]).filter((b) => b.enabled === true).length
    : 0;
  const lockNote = 'locked until a canonical mesh is saved';

  const genStage: Stage = {
    key: 'gen',
    n: '01',
    hueVar: '--sb-acid',
    // results without a canonical mesh mean a PICK is pending — that is a
    // warn (something needs the user), not a done (nothing does)
    state: canonical ? 'done' : (results > 0 ? 'warn' : 'idle'),
    note: canonical
      ? (picked ? `canonical mesh · pick ${picked}` : 'canonical mesh saved')
      : (results > 0 ? `${results} results, none picked` : 'nothing generated'),
  };

  const locked = (key: StageKey, n: string, hueVar: string): Stage => ({
    key,
    n,
    hueVar,
    state: 'locked',
    note: lockNote,
  });

  if (!canonical) {
    return [
      genStage,
      locked('rig', '02', '--sb-magenta'),
      locked('anim', '03', '--sb-cobalt'),
      locked('look', '04', '--sb-cyan'),
      locked('bake', '05', '--sb-sun'),
      locked('export', '06', '--sb-text'),
    ];
  }

  const rigStage: Stage = {
    key: 'rig',
    n: '02',
    hueVar: '--sb-magenta',
    state: rig ? (rig.accepted === true ? 'done' : 'warn') : 'idle',
    note: rig
      ? `track ${rig.track ?? '?'} · ${rig.jointCount ?? '?'} joints · ${
        rig.accepted === true ? 'accepted' : 'unaccepted'
      }`
      : 'no rig recorded',
  };

  return [
    genStage,
    rigStage,
    {
      key: 'anim',
      n: '03',
      hueVar: '--sb-cobalt',
      state: clips > 0 ? 'done' : 'idle',
      note: clips > 0
        ? `${clips} clips enabled`
        : (rig ? 'no clips enabled' : 'no rig to animate yet'),
    },
    {
      key: 'look',
      n: '04',
      hueVar: '--sb-cyan',
      state: typeof look.stylePresetId === 'string' ? 'done' : 'idle',
      note: typeof look.stylePresetId === 'string'
        ? `style ${look.stylePresetId} · camera ${look.cameraPresetId ?? '?'}`
        : 'no look recorded',
    },
    {
      key: 'bake',
      n: '05',
      hueVar: '--sb-sun',
      state: typeof m.lastBakeId === 'string' ? 'done' : 'idle',
      note: typeof m.lastBakeId === 'string' ? `bake ${m.lastBakeId}` : 'never baked',
    },
    {
      key: 'export',
      n: '06',
      hueVar: '--sb-text',
      state: has(m.export) ? 'done' : 'idle',
      note: has(m.export) ? 'exported' : 'no export recorded',
    },
  ];
}
