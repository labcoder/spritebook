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
}

export function genArgs(workspace: string, o: GenOptions): string[] {
  const a = ['gen', '--workspace', workspace, '--character', o.characterId];
  if (o.imagePath) a.push('--image', o.imagePath);
  a.push('--model', o.modelId);
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
  // both default ON in core; the flags are the opt-OUTS
  if (!opts.reproject) a.push('--no-reproject');
  if (!opts.colorMatch) a.push('--no-color-match');
  return a;
}

export function animEnableArgs(workspace: string, specs: string[]): string[] {
  return ['anim', '--enable', specs.join(','), '--workspace', workspace];
}

export function animDisableArgs(workspace: string, clipIds: string[]): string[] {
  return ['anim', '--disable', clipIds.join(','), '--workspace', workspace];
}

export function bakeArgs(workspace: string, opts: { onlyInvalidated?: boolean } = {}): string[] {
  const a = ['bake', '--workspace', workspace];
  if (opts.onlyInvalidated) a.push('--only-invalidated');
  return a;
}

export function exportArgs(bakeDir: string, outDir: string, targets: string[]): string[] {
  // --bake takes the bake DIRECTORY; core appends its own manifest.json
  return ['export', '--bake', bakeDir, '--out', outDir, '--targets', targets.join(',')];
}

export function acceptRigArgs(workspace: string, accepted: boolean): string[] {
  return ['rig', '--workspace', workspace, accepted ? '--unaccept' : '--accept'];
}

export function journalArgs(workspace: string, verb: 'undo' | 'redo'): string[] {
  return [verb, '--manifest', `${workspace}/character.json`];
}

export function modelsArgs(
  action: 'list' | 'install' | 'verify' | 'rm',
  ref?: string,
  acceptLicense = false,
): string[] {
  if (action === 'list') return ['models', 'list'];
  const a = ['models', action, ref ?? ''];
  if (action === 'install' && acceptLicense) a.push('--accept-license');
  return a;
}
