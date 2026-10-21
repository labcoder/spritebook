/**
 * Stage 04 (P4-T2): the look as a choice with a stated cost. Camera controls
 * (elevation detents, directions, px/m, cell), style presets carrying
 * their real knobs, a source/saved-sprite comparison from the bake's own
 * atlas at INTEGER zoom, and "marks N frames stale" before Apply — every
 * frame key embeds the whole recipe, so a look change invalidates all of it.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { StudioBridge } from './bridge';
import {
  type CameraPresetRow,
  comparisonDirections,
  DIRECTION_CHOICES,
  ELEVATION_DETENTS,
  lookArgs,
  type LookDraft,
  type LookRecord,
  resolvedCamera,
  resolvedStyle,
  staleFrames,
  type StylePresetRow,
} from './look';
import { t } from './i18n';
import { CliTwin, storedSourcePath } from './gen';
import { useLandFocus } from './focus';
import { Player } from './bakestage';
import { summarize } from './bakeprogress';

/* ---------------- the stage ---------------- */

export function LookStage({ bridge, dir, manifest, onChanged, heading, inspectorToggle }: {
  bridge: StudioBridge;
  dir: string;
  manifest: unknown;
  onChanged: () => void;
  heading: ReactNode;
  inspectorToggle: ReactNode;
}) {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const look = m.look as LookRecord | undefined;
  const [cameras, setCameras] = useState<CameraPresetRow[]>([]);
  const [styles, setStyles] = useState<StylePresetRow[]>([]);
  const [defaults, setDefaults] = useState({ camera: 'standard-30', style: 'pixel' });
  const [error, setError] = useState<string | null>(null);
  const [atlas, setAtlas] = useState<{ manifest: unknown; png: string } | null>(null);
  const [zoom, setZoom] = useState(2);
  const [clip, setClip] = useState('');
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const [draft, setDraft] = useState<LookDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [applied, setApplied] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const [referenceLoading, setReferenceLoading] = useState(false);
  const source = m.source as { kind?: string } | undefined;
  const sourcePath = source?.kind === 'image' ? storedSourcePath(dir, m) : null;

  useEffect(() => {
    let live = true;
    setReference(null);
    setReferenceLoading(sourcePath !== null);
    if (sourcePath) {
      bridge.readImage(sourcePath).then((src) => {
        if (live) {
          setReference(src);
          setReferenceLoading(false);
        }
      }, () => {
        if (live) setReferenceLoading(false);
      });
    }
    return () => {
      live = false;
    };
  }, [bridge, sourcePath]);

  useEffect(() => {
    let live = true;
    bridge.runCli(['look', '--list', '--json']).then((r) => {
      if (!live) return;
      if (r.exitCode !== 0 || r.lines.length === 0) {
        setError(t('could not read the presets — the log drawer has the verbatim reason'));
        return;
      }
      try {
        const doc = JSON.parse(r.lines.at(-1)!);
        setCameras(doc.cameras ?? []);
        setStyles(doc.styles ?? []);
        if (doc.defaults) setDefaults(doc.defaults);
      } catch {
        setError(t('preset output was not JSON'));
      }
    });
    return () => {
      live = false;
    };
  }, [bridge]);

  useEffect(() => {
    let live = true;
    setAtlas(null);
    bridge.readBakeAtlas(dir).then((a) => live && setAtlas(a), () => {});
    return () => {
      live = false;
    };
  }, [bridge, dir, m.lastBakeId]);

  // the RECORDED look, resolved through the presets — the draft's baseline
  const recorded: LookDraft | null = useMemo(() => {
    const cam = resolvedCamera(cameras, look, defaults.camera);
    const sty = resolvedStyle(styles, look, defaults.style);
    if (!cam || !sty) return null;
    return {
      cameraPresetId: cam.id,
      stylePresetId: sty.row.id,
      elevationDeg: cam.elevationDeg,
      directions: cam.directions,
      pixelsPerMeter: cam.pixelsPerMeter,
      cellW: cam.cellPx.w,
      cellH: cam.cellPx.h,
      maxColors: sty.maxColors,
      outlineWidthPx: sty.outlineWidthPx,
    };
  }, [cameras, styles, look, defaults]);

  useEffect(() => {
    if (recorded && draft === null) setDraft(recorded);
  }, [recorded, draft]);

  const summary = useMemo(() => {
    const page = (atlas?.manifest ?? {}) as { frames?: { atlas: { pageIndex: number } }[] };
    // The bridge supplies page 0; do not crop other pages from those bytes.
    return summarize({ ...page, frames: page.frames?.filter((f) => f.atlas.pageIndex === 0) });
  }, [atlas]);
  const savedClip = summary?.clips.includes(clip) ? clip : summary?.clips[0] ?? '';
  const savedDirections = summary
    ? comparisonDirections([
      ...new Set(
        summary.frames.filter((f) => f.clipId === savedClip)
          .map((f) => f.direction),
      ),
    ].sort((a, b) => a - b))
    : [];
  const frameCount =
    summary?.frames.filter((f) => f.clipId === savedClip && f.direction === savedDirections[0])
      .length ?? 0;
  useEffect(() => setFrame(0), [savedClip]);
  useEffect(() => {
    if (!playing || frameCount === 0) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % frameCount), 125);
    return () => clearInterval(timer);
  }, [playing, frameCount]);
  const cameraBase = cameras.find((c) => c.id === draft?.cameraPresetId);
  const styleBase = styles.find((s) => s.id === draft?.stylePresetId);
  const bakedFrames = (() => {
    const bm = (atlas?.manifest ?? {}) as Record<string, unknown>;
    return Array.isArray(bm.frames) ? bm.frames.length : 0;
  })();
  const stale = draft ? staleFrames(bakedFrames, draft, recorded) : 0;
  const dirty = draft !== null && recorded !== null &&
    JSON.stringify(draft) !== JSON.stringify(recorded);
  const args = draft ? lookArgs(dir, draft, cameraBase, styleBase) : [];

  const apply = useCallback(async () => {
    if (busy || !draft) return; // the button stays focusable while recording (aria-busy)
    setBusy(true);
    setFailed(false);
    const r = await bridge.runCli([...args, '--json']);
    setBusy(false);
    if (r.exitCode === 0) {
      setApplied(true);
      setDraft(null); // re-seed from the manifest the reload brings back
      onChanged();
    } else setFailed(true);
  }, [bridge, args, draft, onChanged, busy]);

  const set = (patch: Partial<LookDraft>) => setDraft((cur) => (cur ? { ...cur, ...patch } : cur));

  // A successful record swaps the whole stage for the '…' placeholder and the
  // focused button goes with it — when the reload re-seeds the draft, land
  // the keyboard at the top of the stage (the walkthrough finding).
  useLandFocus(applied && draft !== null && !dirty, '#lookcam');

  if (error) {
    return (
      <div className='lookstage'>
        <header className='editorhead'>{heading}{inspectorToggle}</header>
        <div className='mdl-error mono'>{error}</div>
      </div>
    );
  }
  if (!draft) {
    return (
      <div className='lookstage'>
        <header className='editorhead'>{heading}{inspectorToggle}</header>
        <div className='inote'>…</div>
      </div>
    );
  }

  return (
    <div className='lookstage'>
      <header className='editorhead'>
        {heading}
        <div className='lookapply'>
          <div className='gensechead'>
            {dirty && stale > 0 && (
              <span className='stalecost mono' role='status'>
                {t('marks')} {stale} {t('frames stale')}
              </span>
            )}
            {dirty && stale === 0 && (
              <span className='inote'>{t('nothing baked yet — no frames to invalidate')}</span>
            )}
          </div>
          <div className='genrow'>
            {
              /* !dirty is a real input blocker; busy is not — disabling the
              focused button while the run flies drops keyboard focus to
              <body> */
            }
            <button
              type='button'
              className='btn primary'
              disabled={!dirty}
              aria-busy={busy}
              onClick={apply}
            >
              {busy ? t('Recording…') : t('Record look')}
            </button>
            {dirty && (
              <button
                type='button'
                className='btn mbtn'
                onClick={() => {
                  if (busy) return; // the run in flight is recording this draft
                  setDraft(recorded);
                  // the reset clears `dirty`, which unmounts THIS button - land
                  // at the top of the stage rather than dropping to <body>
                  requestAnimationFrame(() => {
                    document.querySelector<HTMLElement>('#lookcam')?.focus();
                  });
                }}
              >
                {t('Reset to recorded')}
              </button>
            )}
            {!dirty && (
              <span className='inote'>
                {look !== undefined
                  ? t('this is the recorded look')
                  // F11: the note claimed a recording that did not exist while
                  // the inspector said "no look recorded" one panel over
                  : t('nothing recorded yet — Record look writes these values')}
              </span>
            )}
          </div>
          {failed && (
            <span className='mv-exit mono' role='status'>
              {t('failed — the log drawer has the verbatim reason')}
            </span>
          )}
          <CliTwin args={args} />
        </div>
        {inspectorToggle}
      </header>
      <div className='lookcomparison'>
        <section className='referencepane'>
          <div className='gensechead'>
            <span className='hud'>{t('Reference')}</span>
          </div>
          <div className='referencewell'>
            {reference
              ? <img src={reference} alt={t('Original character reference')} />
              : (
                <p className='inote' role='status'>
                  {referenceLoading
                    ? t('Loading reference...')
                    : sourcePath
                    ? t('Reference unavailable. Check the source file in the workspace.')
                    : t('No source image for this character.')}
                </p>
              )}
          </div>
          <p className='inote'>{t('Original input')}</p>
        </section>
        <section className='outputpane'>
          <div className='gensechead'>
            <span className='hud'>{t('Saved output')}</span>
            {summary && <span className='inote mono'>{summary.bakeId}</span>}
            <div className='zoom' role='group' aria-label={t('Zoom')}>
              {[1, 2, 4, 6].map((z) => (
                <button
                  key={z}
                  type='button'
                  aria-pressed={zoom === z}
                  onClick={() => setZoom(z)}
                >
                  {z}×
                </button>
              ))}
            </div>
          </div>
          {atlas && summary
            ? (
              <>
                <div className='savedwell'>
                  {savedDirections.map((direction) => (
                    <div className='savedview' key={direction}>
                      <Player
                        summary={summary}
                        atlasPng={atlas.png}
                        pass='lit'
                        dir={direction}
                        clip={savedClip}
                        playing={false}
                        frame={frame}
                        fps={8}
                        zoom={zoom}
                      />
                      <span>{t('direction')} {direction}</span>
                    </div>
                  ))}
                </div>
                <div className='savedtransport'>
                  <button
                    type='button'
                    className='btn mbtn'
                    aria-pressed={playing}
                    onClick={() => setPlaying((current) => !current)}
                  >
                    {playing ? t('Pause') : t('Play')}
                  </button>
                  <label htmlFor='savedclip'>{t('Clip')}</label>
                  <select
                    id='savedclip'
                    className='optnum'
                    value={savedClip}
                    onChange={(e) => setClip(e.target.value)}
                  >
                    {summary.clips.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </div>
                <div className='inote'>
                  {t('Saved atlas page 1. Nearest-neighbor at integer zoom.')}
                  {dirty ? ` · ${t('these pixels are the OLD look')}` : ''}
                </div>
              </>
            )
            : (
              <div className='inote previewempty'>
                {t('no bake yet — Bake renders what this stage records')}
              </div>
            )}
        </section>
      </div>
      <section className='lookrecipe' aria-label={t('Look recipe')}>
        <h2>{t('Look recipe')}</h2>
        <div className='lookfields'>
          <div className='lookfield'>
            <label htmlFor='lookcam'>{t('Camera')}</label>
            <select
              id='lookcam'
              value={draft.cameraPresetId}
              onChange={(e) => {
                const base = cameras.find((c) => c.id === e.target.value);
                set(
                  base
                    ? {
                      cameraPresetId: base.id,
                      elevationDeg: base.elevationDeg,
                      directions: base.directions,
                      pixelsPerMeter: base.pixelsPerMeter,
                      cellW: base.cellPx.w,
                      cellH: base.cellPx.h,
                    }
                    : { cameraPresetId: e.target.value },
                );
              }}
            >
              {cameras.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
            </select>
          </div>
          <div className='lookfield'>
            <label htmlFor='lookdirs'>{t('Directions')}</label>
            <select
              id='lookdirs'
              value={draft.directions}
              onChange={(e) => set({ directions: Number(e.target.value) })}
            >
              {DIRECTION_CHOICES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className='lookfield'>
            <label htmlFor='lookcellw'>{t('Cell')}</label>
            <div className='lookcell'>
              <input
                id='lookcellw'
                type='number'
                min={1}
                value={draft.cellW}
                aria-label={t('Cell width')}
                onChange={(e) => set({ cellW: Number(e.target.value) || 1 })}
              />
              <span aria-hidden='true'>×</span>
              <input
                type='number'
                min={1}
                value={draft.cellH}
                aria-label={t('Cell height')}
                onChange={(e) => set({ cellH: Number(e.target.value) || 1 })}
              />
            </div>
          </div>
          <div className='lookfield'>
            <label htmlFor='lookstyle'>{t('Style')}</label>
            <select
              id='lookstyle'
              value={draft.stylePresetId}
              onChange={(e) => {
                const style = styles.find((s) => s.id === e.target.value);
                if (style) {
                  set({
                    stylePresetId: style.id,
                    maxColors: style.maxColors,
                    outlineWidthPx: style.outlineWidthPx,
                  });
                }
              }}
            >
              {styles.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
            </select>
          </div>
          <div className='lookfield'>
            {styleBase?.maxColors !== undefined
              ? (
                <>
                  <label htmlFor='lookcolors'>{t('Colours')}</label>
                  <input
                    id='lookcolors'
                    type='number'
                    min={2}
                    max={256}
                    value={draft.maxColors ?? styleBase.maxColors}
                    onChange={(e) => set({ maxColors: Number(e.target.value) || 2 })}
                  />
                </>
              )
              : (
                <>
                  <span>{t('Colours')}</span>
                  <span className='inote'>{t('no palette')}</span>
                </>
              )}
          </div>
          <div className='lookfield'>
            {styleBase?.outlineWidthPx !== undefined
              ? (
                <>
                  <label htmlFor='lookoutline'>{t('Outline px')}</label>
                  <input
                    id='lookoutline'
                    type='number'
                    min={0.25}
                    max={8}
                    step={0.25}
                    value={draft.outlineWidthPx ?? styleBase.outlineWidthPx}
                    onChange={(e) => set({ outlineWidthPx: Number(e.target.value) || 0.25 })}
                  />
                </>
              )
              : (
                <>
                  <span>{t('Outline px')}</span>
                  <span className='inote'>{t('no outline')}</span>
                </>
              )}
          </div>
        </div>
        <details className='lookadvanced'>
          <summary>{t('Camera and style details')}</summary>
          <div className='genrow'>
            <label htmlFor='lookelev'>{t('Elevation')}</label>
            <input
              id='lookelev'
              type='range'
              min={0}
              max={89}
              step={0.001}
              value={draft.elevationDeg}
              className='lookslider'
              onChange={(e) => set({ elevationDeg: Number(e.target.value) })}
              onKeyDown={(e) => {
                const by = e.key === 'ArrowUp' || e.key === 'ArrowRight'
                  ? 0.5
                  : e.key === 'ArrowDown' || e.key === 'ArrowLeft'
                  ? -0.5
                  : e.key === 'PageUp'
                  ? 5
                  : e.key === 'PageDown'
                  ? -5
                  : null;
                if (by === null) return;
                e.preventDefault();
                set({ elevationDeg: Math.min(89, Math.max(0, draft.elevationDeg + by)) });
              }}
            />
            <span className='mono lookval'>{draft.elevationDeg.toFixed(3)}°</span>
            <span className='detents'>
              {ELEVATION_DETENTS.map((d) => (
                <button
                  key={d.deg}
                  type='button'
                  className='btn mbtn'
                  aria-pressed={Math.abs(draft.elevationDeg - d.deg) < 0.0005}
                  onClick={() => set({ elevationDeg: d.deg })}
                >
                  {d.label}
                </button>
              ))}
            </span>
          </div>
          <div className='genrow'>
            <label htmlFor='lookppm'>{t('Pixels per metre')}</label>
            <input
              id='lookppm'
              type='number'
              className='optnum mono'
              min={1}
              value={draft.pixelsPerMeter}
              onChange={(e) => set({ pixelsPerMeter: Number(e.target.value) || 1 })}
            />
            {styleBase && (
              <span className='inote'>
                {styleBase.mode}
                {styleBase.superSample ? ` · ${styleBase.superSample}× ${t('supersample')}` : ''}
              </span>
            )}
          </div>
        </details>
      </section>
    </div>
  );
}
