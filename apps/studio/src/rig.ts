/**
 * The deform report, projected for the Rig stage — HONESTLY: rows are the
 * report's own flags verbatim, ordered by how badly they tear (max edge
 * stretch), with the clean-joint count stated rather than hidden. Pure and
 * pinned against the real bulma-fixed report by rig_test.ts.
 */

export interface JointRow {
  joint: string;
  flags: string[];
  /** ×1.0 = no stretch; the report's own number */
  maxEdgeStretch: number;
  meanDisplacementM: number;
  /** Separate surfaces, including valid clothing/accessories. */
  spannedComponents: number;
  influencedEdges: number;
  stretchedEdges: number;
}

export interface RigReportView {
  poses: string[];
  totalJoints: number;
  flagged: JointRow[];
  cleanCount: number;
  namedCount: number;
  fingerCount: number;
  handBranches: { left: number | null; right: number | null };
}

export function projectReport(report: unknown): RigReportView | null {
  if (report === null || typeof report !== 'object') return null;
  const r = report as Record<string, unknown>;
  const joints = Array.isArray(r.joints) ? r.joints : null;
  if (!joints) return null;
  const entries = joints.map((j) =>
    (j !== null && typeof j === 'object' ? j : {}) as Record<string, unknown>
  );
  const rows: JointRow[] = [];
  let clean = 0;
  for (const j of joints) {
    const o = (j ?? {}) as Record<string, unknown>;
    const flags = Array.isArray(o.flags) ? o.flags.map(String) : [];
    if (flags.length === 0) {
      clean++;
      continue;
    }
    rows.push({
      joint: String(o.joint ?? '?'),
      flags,
      maxEdgeStretch: typeof o.maxEdgeStretch === 'number' ? o.maxEdgeStretch : 0,
      meanDisplacementM: typeof o.meanDisplacementM === 'number' ? o.meanDisplacementM : 0,
      spannedComponents: typeof o.spannedComponents === 'number' ? o.spannedComponents : 1,
      influencedEdges: typeof o.influencedEdges === 'number' ? o.influencedEdges : 0,
      stretchedEdges: typeof o.stretchedEdges === 'number' ? o.stretchedEdges : 0,
    });
  }
  rows.sort((a, b) => b.maxEdgeStretch - a.maxEdgeStretch);
  return {
    poses: Array.isArray(r.poses) ? r.poses.map(String) : [],
    totalJoints: joints.length,
    flagged: rows,
    cleanCount: clean,
    namedCount:
      entries.filter((j) => typeof j.joint === 'string' && !/^bone_\d+$/.test(j.joint)).length,
    fingerCount:
      entries.filter((j) =>
        typeof j.joint === 'string' && /^(thumb|index|middle|ring|pinky)_/.test(j.joint)
      ).length,
    handBranches: {
      left: entries.some((j) => j.joint === 'hand_l' && j.parent !== undefined)
        ? entries.filter((j) => j.parent === 'hand_l').length
        : null,
      right: entries.some((j) => j.joint === 'hand_r' && j.parent !== undefined)
        ? entries.filter((j) => j.parent === 'hand_r').length
        : null,
    },
  };
}

/** The run/re-run arg builder — one place, so the CLI twin IS the command. */
export function rigRunArgs(dir: string, opts: {
  trackA?: boolean;
  bodyDir?: string;
  fixes?: string[];
  editsPath?: string;
  rerunWithHints?: boolean;
  autoHints?: boolean;
}): string[] {
  const a = [
    'rig',
    '--model',
    `${dir}/canonical/model.glb`,
    '--out',
    `${dir}/rig`,
    '--workspace',
    dir,
  ];
  if (opts.trackA) {
    a.push('--track-a');
    if (opts.bodyDir) a.push('--body', opts.bodyDir);
  }
  for (const f of opts.fixes ?? []) {
    if (f.startsWith('rotate-')) a.push('--rotate', f.slice('rotate-'.length));
    else a.push(`--${f}`);
  }
  if (opts.editsPath) a.push('--edits', opts.editsPath);
  if (opts.rerunWithHints) a.push('--rerun-with-hints');
  if (opts.autoHints) a.push('--auto-hints');
  return a;
}
