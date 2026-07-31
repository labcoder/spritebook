/**
 * The gallery's read-only projection of a character manifest. Deliberately
 * defensive: the gallery must render SOMETHING for any workspace the CLI
 * would accept, and say what it could not read rather than hide the card —
 * a manifest this fails to project is a finding, not a blank.
 */

export interface CharacterCard {
  dir: string;
  id: string;
  displayName: string;
  stylePresetId?: string;
  cameraPresetId?: string;
  rig?: { track: string; accepted: boolean; jointCount?: number };
  pickedResultId?: string;
  lastBakeId?: string;
  heightM?: number;
  sourceKind?: string;
  /** set when the manifest did not project cleanly */
  problem?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function toCard(dir: string, manifest: unknown): CharacterCard {
  if (manifest === null || typeof manifest !== 'object') {
    return {
      dir,
      id: dir,
      displayName: dir,
      problem: 'manifest is not an object',
    };
  }
  const m = manifest as Record<string, unknown>;
  const id = str(m.id);
  if (!id) {
    return { dir, id: dir, displayName: dir, problem: 'manifest has no id' };
  }

  const look = (m.look ?? {}) as Record<string, unknown>;
  const rig = m.rig as Record<string, unknown> | undefined;
  const gen = (m.generation ?? {}) as Record<string, unknown>;
  const mesh = (m.canonicalMesh ?? {}) as Record<string, unknown>;
  const source = (m.source ?? {}) as Record<string, unknown>;

  return {
    dir,
    id,
    displayName: str(m.displayName) ?? id,
    stylePresetId: str(look.stylePresetId),
    cameraPresetId: str(look.cameraPresetId),
    rig: rig
      ? {
        track: str(rig.track) ?? '?',
        accepted: rig.accepted === true,
        jointCount: typeof rig.jointCount === 'number' ? rig.jointCount : undefined,
      }
      : undefined,
    pickedResultId: str(gen.pickedResultId),
    lastBakeId: str(m.lastBakeId),
    heightM: typeof mesh.heightM === 'number' ? mesh.heightM : undefined,
    sourceKind: str(source.kind),
  };
}
