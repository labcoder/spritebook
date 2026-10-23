/**
 * Every CLI line the GUI can build, in one react-free place.
 *
 * This exists so the parity test can execute the EXACT arguments the buttons
 * execute — importing the builders rather than retyping them, which is the
 * only version of that test worth having. `rig.ts` and `look.ts` keep their
 * own builders (they are stage-shaped); everything else lives here.
 */

export interface GenOptions {
  characterId: string;
  imagePath: string;
  modelId: string;
  /** the schema-form values, already reduced to what diverges from defaults */
  adjust?: string | null;
  seed?: number;
  candidates?: number;
  /** declared standing height in metres (D-012); omitted = backend scale */
  heightM?: number;
}

export function genArgs(workspace: string, o: GenOptions): string[] {
  const a = ['gen', '--workspace', workspace, '--character', o.characterId];
  if (o.imagePath) a.push('--image', o.imagePath);
  a.push('--model', o.modelId);
  // the size every later stage believes: bake frames at pixelsPerMeter, so
  // skipping this keeps the backend's unit-box scale and sprites bake tiny
  if (o.heightM !== undefined) a.push('--height', String(o.heightM));
  if (o.seed !== undefined) a.push('--seed', String(o.seed));
  if (o.candidates !== undefined && o.candidates > 1) {
    a.push('--candidates', String(o.candidates));
  }
  if (o.adjust) a.push('--adjust', o.adjust);
  return a;
}

export function moreLikeArgs(workspace: string, characterId: string, resultId: string): string[] {
  // gen ALWAYS requires --character, even when varying an existing result
  return ['gen', '--workspace', workspace, '--character', characterId, '--more-like', resultId];
}

export function pickArgs(
  workspace: string,
  resultId: string,
  opts: { reproject: boolean; colorMatch: boolean },
): string[] {
  const a = ['pick', '--workspace', workspace, '--result', resultId];
  if (opts.reproject) a.push('--reproject');
  if (opts.colorMatch) a.push('--color-match');
  return a;
}

export function animEnableArgs(workspace: string, specs: string[]): string[] {
  return ['anim', '--enable', specs.join(','), '--workspace', workspace];
}

export function animDisableArgs(workspace: string, clipIds: string[]): string[] {
  return ['anim', '--disable', clipIds.join(','), '--workspace', workspace];
}

/** D-038: core retargets the clip once and writes a small preview glb. */
export function animPreviewArgs(workspace: string, clipId: string): string[] {
  return ['anim', '--preview', clipId, '--workspace', workspace];
}

export function bakeArgs(workspace: string, opts: { onlyInvalidated?: boolean } = {}): string[] {
  const a = ['bake', '--workspace', workspace];
  if (opts.onlyInvalidated) a.push('--only-invalidated');
  return a;
}

export function exportArgs(
  workspace: string,
  outDir: string,
  targets: string[],
  mesh = false,
): string[] {
  // Core selects the accepted lastBakeId, including after undo.
  return [
    'export',
    '--workspace',
    workspace,
    '--out',
    outDir,
    ...(targets.length ? ['--targets', targets.join(',')] : []),
    ...(mesh ? ['--mesh'] : []),
  ];
}

/** A NEW texture on an existing result's mesh - a new result card appears.
 * Core bumps the seed per run, so calling it twice gives two textures. */
export function retextureArgs(workspace: string, resultId: string): string[] {
  return ['retexture', '--workspace', workspace, '--result', resultId];
}

export function acceptRigArgs(workspace: string, accepted: boolean): string[] {
  return ['rig', '--workspace', workspace, accepted ? '--unaccept' : '--accept'];
}

export function journalArgs(workspace: string, verb: 'undo' | 'redo'): string[] {
  return [verb, '--manifest', `${workspace}/character.json`];
}

export function modelsArgs(
  action: 'list' | 'install' | 'setup' | 'verify' | 'rm',
  ref?: string,
  acceptLicense = false,
): string[] {
  if (action === 'list') return ['models', 'list'];
  const a = ['models', action, ref ?? ''];
  if ((action === 'install' || action === 'setup') && acceptLicense) a.push('--accept-license');
  return a;
}
