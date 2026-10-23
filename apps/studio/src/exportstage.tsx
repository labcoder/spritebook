import { Inspector } from './workbench';
/**
 * Stage 06 (P4-T2): targets over ONE BakeManifest (exporters are pure
 * projections, D-010 — so this stage picks formats, never re-renders), the
 * files that landed, and a way to open the folder they landed in.
 */
import { useCallback, useEffect, useState } from 'react';
import type { StudioBridge } from './bridge';
import { summarize } from './bakeprogress';
import { t } from './i18n';
import { CliTwin } from './gen';
import { exportArgs } from './args';
import { useLandFocus } from './focus';

/** core's ExportTargetIdSchema, in its own order. */
const TARGETS = ['godot', 'aseprite', 'texturepacker', 'strips'] as const;

function targetNote(id: string): string {
  switch (id) {
    case 'godot':
      return t('a .tres SpriteFrames resource with the anchor box');
    case 'aseprite':
      return t('an .aseprite-importable sheet plus its JSON');
    case 'texturepacker':
      return t('the TexturePacker JSON (hash) sheet description');
    default:
      return t('one PNG strip per clip and direction');
  }
}

export function ExportStage({ bridge, dir, manifest, onChanged }: {
  bridge: StudioBridge;
  dir: string;
  manifest: unknown;
  onChanged: () => void;
}) {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const bakeId = typeof m.lastBakeId === 'string' ? m.lastBakeId : null;
  const [selected, setSelected] = useState<string[]>(['godot']);
  const [includeMesh, setIncludeMesh] = useState(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [frames, setFrames] = useState<number | null>(null);

  // a finished export mounts the Done section while focus sits on the Export
  // button — land it on Open folder, the verb that matters once files exist;
  // artifacts resets to [] at run start, so this only rises when a run lands
  useLandFocus(artifacts.length > 0, '.openfolder');

  useEffect(() => {
    let live = true;
    bridge.readBakeAtlas(dir, 'lit').then((a) => {
      if (!live) return;
      const s = a ? summarize(a.manifest) : null;
      setFrames(s ? s.frames.length : null);
    }, () => {});
    return () => {
      live = false;
    };
  }, [bridge, dir, bakeId]);

  const outDir = `${dir}/export`;
  const args = exportArgs(dir, outDir, bakeId ? selected : [], includeMesh);

  const runExport = useCallback(async () => {
    if (running) return; // the button stays focusable while running (aria-busy)
    setRunning(true);
    setFailed(false);
    setArtifacts([]);
    const written: string[] = [];
    const r = await bridge.runCli([...args, '--json'], (line) => {
      try {
        const e = JSON.parse(line);
        if (e?.t === 'artifact' && typeof e.path === 'string') written.push(e.path);
      } catch { /* not an event we project */ }
    });
    setRunning(false);
    setArtifacts(written);
    if (r.exitCode === 0) onChanged();
    else setFailed(true);
  }, [bridge, args, onChanged, running]);

  const toggle = (id: string) =>
    setSelected((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);

  return (
    <div className='exportstage workbench-stage'>
      <div className='asset-workspace'>
        <section className='gensec'>
          {bakeId === null
            ? (
              <div className='inote'>
                {t('Bake a sprite sheet first, or export the 3D model and textures now.')}
              </div>
            )
            : (
              <div className='inote'>
                {t('one bake, many formats')}: {t('bake')} {bakeId}
                {frames !== null ? ` · ${frames} ${t('frames')}` : ''}
              </div>
            )}
        </section>

        {artifacts.length > 0 && (
          <section className='gensec'>
            <div className='gensechead'>
              <span className='hud'>{t('Done')}</span>
              {
                /* core emits ONE artifact per target, and it is a FOLDER — the
                list says so rather than implying a file count it never gave */
              }
              <span className='mono dimtext'>
                {artifacts.length} {t('folders')}
              </span>
              <button
                type='button'
                className='btn mbtn openfolder'
                onClick={() => bridge.openFolder(outDir)}
              >
                {t('Open folder')}
              </button>
            </div>
            <div className='filelist mono'>
              {artifacts.map((p) => (
                <div key={p} className='fileline'>
                  <span className='filepath' title={p}>{p}</span>
                  <button
                    type='button'
                    className='btn mbtn'
                    onClick={() => bridge.openFolder(p)}
                  >
                    {t('Open')}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <Inspector>
        <div className='inspector-scroll'>
          <section className='gensec'>
            <div className='gensechead'>
              <span className='hud'>{t('Targets')}</span>
            </div>
            <div className='targets' role='group' aria-label={t('Targets')}>
              {TARGETS.map((id) => (
                <label key={id} className='target'>
                  <input
                    type='checkbox'
                    checked={selected.includes(id)}
                    disabled={bakeId === null}
                    onChange={() => toggle(id)}
                  />
                  <span className='targetname mono'>{id}</span>
                  <span className='inote'>{targetNote(id)}</span>
                </label>
              ))}
            </div>
            <label className='target'>
              <input
                type='checkbox'
                checked={includeMesh}
                onChange={(e) => setIncludeMesh(e.target.checked)}
              />
              <span className='targetname'>{t('3D model & textures')}</span>
              <span className='inote'>
                {t(
                  'Canonical GLB with embedded textures, plus separate texture files. Includes the saved rig when present.',
                )}
              </span>
            </label>
          </section>
        </div>
        <section className='gensec action-section'>
          <div className='genrow'>
            {
              /* disabled only for the INPUT blockers — disabling while running
              drops keyboard focus to <body> (walkthrough finding) */
            }
            <button
              type='button'
              className='btn primary'
              disabled={!includeMesh && (bakeId === null || selected.length === 0)}
              aria-busy={running}
              onClick={runExport}
            >
              {running ? t('Exporting…') : t('Export selected')}
            </button>
            {!includeMesh && selected.length === 0 && (
              <span className='inote'>{t('pick at least one target')}</span>
            )}
            {failed && (
              <span className='mv-exit mono' role='status'>
                {t('failed — the log drawer has the verbatim reason')}
              </span>
            )}
          </div>
          <CliTwin args={args} />
        </section>
      </Inspector>
    </div>
  );
}
