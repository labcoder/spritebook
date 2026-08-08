/**
 * Stage 04 (P4-T2): the look as a choice with a stated cost. Camera controls
 * (elevation detents, directions, px/m, cell), style preset cards carrying
 * their real knobs, pixel-truth direction strips sliced from the last bake's
 * own atlas at INTEGER zoom, and "marks N frames stale" before Apply — every
 * frame key embeds the whole recipe, so a look change invalidates all of it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StudioBridge } from './bridge';
import {
  type CameraPresetRow,
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
import { CliTwin } from './gen';
import { useLandFocus, useRovingRadio } from './focus';

interface BakeFrame {
  clipId: string;
  direction: number;
  frame: number;
  atlas: { x: number; y: number; w: number; h: number; pageIndex: number };
}

/* ---------------- pixel-truth strips ---------------- */

function DirectionStrips({ atlas, zoom }: {
  atlas: { manifest: unknown; png: string };
  zoom: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const m = (atlas.manifest ?? {}) as Record<string, unknown>;
  const frames = (Array.isArray(m.frames) ? m.frames : []) as BakeFrame[];
  const rows = useMemo(() => {
    const byDir = new Map<number, BakeFrame[]>();
    for (const f of frames) {
      const list = byDir.get(f.direction) ?? [];
      list.push(f);
      byDir.set(f.direction, list);
    }
    return [...byDir.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dir, fs]) => [dir, fs.sort((a, b) => a.frame - b.frame)] as const);
  }, [frames]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || rows.length === 0) return;
    const cellW = rows[0]![1][0]?.atlas.w ?? 64;
    const cellH = rows[0]![1][0]?.atlas.h ?? 64;
    const cols = Math.max(...rows.map(([, fs]) => fs.length));
    canvas.width = cols * cellW * zoom;
    canvas.height = rows.length * cellH * zoom;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // pixel truth: nearest-neighbor at integer zoom, never a smooth scale
    ctx.imageSmoothingEnabled = false;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      rows.forEach(([, fs], r) => {
        fs.forEach((f, c) => {
          ctx.drawImage(
            img,
            f.atlas.x,
            f.atlas.y,
            f.atlas.w,
            f.atlas.h,
            c * cellW * zoom,
            r * cellH * zoom,
            cellW * zoom,
            cellH * zoom,
          );
        });
      });
    };
    img.src = `data:image/png;base64,${atlas.png}`;
  }, [atlas.png, rows, zoom]);

  if (rows.length === 0) return null;
  return (
    <div className='strips'>
      <canvas
        ref={ref}
        className='stripcanvas'
        role='img'
        aria-label={`${rows.length} ${t('direction strips from the last bake')}`}
      />
    </div>
  );
}

/* ---------------- the stage ---------------- */

export function LookStage({ bridge, dir, manifest, onChanged }: {
  bridge: StudioBridge;
  dir: string;
  manifest: unknown;
  onChanged: () => void;
}) {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const look = m.look as LookRecord | undefined;
  const [cameras, setCameras] = useState<CameraPresetRow[]>([]);
  const [styles, setStyles] = useState<StylePresetRow[]>([]);
  const [defaults, setDefaults] = useState({ camera: 'standard-30', style: 'pixel' });
  const [error, setError] = useState<string | null>(null);
  const [atlas, setAtlas] = useState<{ manifest: unknown; png: string } | null>(null);
  const [zoom, setZoom] = useState(2);
  const [draft, setDraft] = useState<LookDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [applied, setApplied] = useState(false);

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

  // the radio-group keyboard contract the role announces
  const styleRoving = useRovingRadio(
    styles.length,
    styles.findIndex((s) => s.id === draft?.stylePresetId),
    (i) => {
      const s = styles[i];
      if (s) set({ stylePresetId: s.id, maxColors: s.maxColors, outlineWidthPx: s.outlineWidthPx });
    },
  );

  if (error) {
    return (
      <div className='lookstage'>
        <div className='mdl-error mono'>{error}</div>
      </div>
    );
  }
  if (!draft) {
    return (
      <div className='lookstage'>
        <div className='inote'>…</div>
      </div>
    );
  }

  return (
    <div className='lookstage'>
      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('Camera')}</span>
          <span className='ieyebrow mono'>04// LOOK</span>
        </div>
        <div className='genrow'>
          <label htmlFor='lookcam'>{t('Preset')}</label>
          <select
            id='lookcam'
            className='optnum mono'
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
        <div className='genrow'>
          <label htmlFor='lookelev'>{t('Elevation')}</label>
          <input
            id='lookelev'
            type='range'
            min={0}
            max={89}
            step={0.001}
            value={draft.elevationDeg}
            onChange={(e) => set({ elevationDeg: Number(e.target.value) })}
            onKeyDown={(e) => {
              // the native 0.001° step serves the pointer — end to end by
              // arrow key is ~89000 presses, so keys move in half-degrees
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
            className='lookslider'
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
          <label id='dirslabel'>{t('Directions')}</label>
          <span className='m-seg' role='group' aria-labelledby='dirslabel'>
            {DIRECTION_CHOICES.map((d) => (
              <button
                key={d}
                type='button'
                className='btn mbtn'
                aria-pressed={draft.directions === d}
                onClick={() => set({ directions: d })}
              >
                {d}
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
          <label htmlFor='lookcellw'>{t('Cell')}</label>
          <input
            id='lookcellw'
            type='number'
            className='optnum mono cellnum'
            min={1}
            value={draft.cellW}
            aria-label={t('Cell width')}
            onChange={(e) => set({ cellW: Number(e.target.value) || 1 })}
          />
          <span className='mono'>×</span>
          <input
            type='number'
            className='optnum mono cellnum'
            min={1}
            value={draft.cellH}
            aria-label={t('Cell height')}
            onChange={(e) => set({ cellH: Number(e.target.value) || 1 })}
          />
        </div>
      </section>

      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('Style')}</span>
        </div>
        <div className='backends' role='radiogroup' aria-label={t('Style')}>
          {styles.map((s, i) => (
            <button
              key={s.id}
              type='button'
              role='radio'
              aria-checked={draft.stylePresetId === s.id}
              className={`backend ${draft.stylePresetId === s.id ? 'on' : ''}`}
              {...styleRoving(i)}
              onClick={() =>
                set({
                  stylePresetId: s.id,
                  maxColors: s.maxColors,
                  outlineWidthPx: s.outlineWidthPx,
                })}
            >
              <span className='bname'>{s.id}</span>
              <span className='btags'>
                <span className='mbadge kind'>{s.mode}</span>
                <span className='mbadge'>
                  {s.maxColors ? `${s.maxColors} ${t('colours')}` : t('no palette')}
                </span>
                <span className='mbadge'>
                  {s.outlineWidthPx ? `${t('outline')} ${s.outlineWidthPx}px` : t('no outline')}
                </span>
                {s.superSample && (
                  <span className='mbadge'>{s.superSample}× {t('supersample')}</span>
                )}
              </span>
            </button>
          ))}
        </div>
        {(styleBase?.maxColors !== undefined || styleBase?.outlineWidthPx !== undefined) && (
          <div className='genrow'>
            {styleBase?.maxColors !== undefined && (
              <>
                <label htmlFor='lookcolors'>{t('Colours')}</label>
                <input
                  id='lookcolors'
                  type='number'
                  className='optnum mono'
                  min={2}
                  max={256}
                  value={draft.maxColors ?? styleBase.maxColors}
                  onChange={(e) => set({ maxColors: Number(e.target.value) || 2 })}
                />
              </>
            )}
            {styleBase?.outlineWidthPx !== undefined && (
              <>
                <label htmlFor='lookoutline'>{t('Outline px')}</label>
                <input
                  id='lookoutline'
                  type='number'
                  className='optnum mono'
                  min={0.25}
                  max={8}
                  step={0.25}
                  value={draft.outlineWidthPx ?? styleBase.outlineWidthPx}
                  onChange={(e) => set({ outlineWidthPx: Number(e.target.value) || 0.25 })}
                />
              </>
            )}
          </div>
        )}
      </section>

      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('Apply')}</span>
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
      </section>

      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('Last bake')}</span>
          <div className='zoom' role='group' aria-label={t('Zoom')}>
            {[1, 2, 4].map((z) => (
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
        {atlas
          ? (
            <>
              <DirectionStrips atlas={atlas} zoom={zoom} />
              <div className='inote'>
                {t('nearest-neighbor · integer zoom · one row per direction')}
                {dirty ? ` · ${t('these pixels are the OLD look')}` : ''}
              </div>
            </>
          )
          : <div className='inote'>{t('no bake yet — Bake renders what this stage records')}</div>}
      </section>
    </div>
  );
}
