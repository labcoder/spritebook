import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StudioBridge } from './bridge';
import { Inspector } from './workbench';
import { Viewport } from './viewport/Viewport';
import type { CaptureCamera } from './viewport/meshviewport';
import { CliTwin } from './gen';
import { t } from './i18n';
import {
  type CameraPresetRow,
  lookArgs,
  type LookDraft,
  type LookRecord,
  resolvedCamera,
  resolvedStyle,
  type StylePresetRow,
} from './look';
import type { StageKey } from './stages';

interface FramePreview {
  meshPath: string;
  imagePath: string;
  time: number;
  paletteProvisional: boolean;
  flags: { code: string; message: string }[];
}

/** Compose one frame here; Bake renders the recorded recipe over the animation set. */
export function LookStage({ bridge, dir, manifest, onChanged, onGoToStage }: {
  bridge: StudioBridge;
  dir: string;
  manifest: unknown;
  onChanged: () => void;
  onGoToStage: (stage: StageKey) => void;
}) {
  const m = (manifest ?? {}) as {
    look?: LookRecord;
    canonicalMesh?: { heightM: number; gltfSha256: string };
    animationSet?: { clipId: string; frames: number; enabled: boolean }[];
  };
  const [cameras, setCameras] = useState<CameraPresetRow[]>([]);
  const [styles, setStyles] = useState<StylePresetRow[]>([]);
  const [draft, setDraft] = useState<LookDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [preview, setPreview] = useState<FramePreview | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [previewRecipe, setPreviewRecipe] = useState('');
  const [clipId, setClipId] = useState(() =>
    m.animationSet?.find((c) => c.enabled)?.clipId ?? 'walk-loop'
  );
  const [frame, setFrame] = useState(0);
  const [direction, setDirection] = useState(0);
  const [nativeSize, setNativeSize] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const clips = (m.animationSet ?? []).filter((c) => c.enabled);
  const frames = clips.find((c) => c.clipId === clipId)?.frames ?? 12;
  const cameraBase = cameras.find((c) => c.id === draft?.cameraPresetId);
  const styleBase = styles.find((s) => s.id === draft?.stylePresetId);

  useEffect(() => {
    let active = true;
    bridge.runCli(['look', '--list', '--json']).then((r) => {
      if (!active) return;
      if (r.exitCode !== 0) {
        throw new Error(t('Could not load capture presets. Open logs and retry.'));
      }
      const data = JSON.parse(r.lines.at(-1)!);
      setCameras(data.cameras);
      setStyles(data.styles);
    }).catch((e) => {
      if (active) setError(String(e));
    });
    return () => {
      active = false;
    };
  }, [bridge]);

  const recorded = useMemo((): LookDraft | null => {
    const c = resolvedCamera(cameras, m.look, 'standard-30');
    const s = resolvedStyle(styles, m.look, 'clean');
    if (!c || !s) return null;
    const overrides = m.look?.overrides as {
      temporal?: { superSample?: number };
      lighting?: { direction: number[]; ambient: number; frame: string };
    } | undefined;
    const light = overrides?.lighting ?? s.row.lighting ??
      { direction: [0.4, 0.9, 0.5], ambient: 0.3, frame: 'camera' };
    const d = light.direction;
    const fresh = !m.look;
    return {
      cameraPresetId: c.id,
      stylePresetId: s.row.id,
      elevationDeg: c.elevationDeg,
      directions: c.directions,
      yawOffsetDeg: c.yawOffsetDeg,
      orthographic: c.orthographic ?? true,
      fovDeg: c.fovDeg ?? 35,
      pixelsPerMeter: fresh
        ? Math.round(330 / (m.canonicalMesh?.heightM ?? 1.7))
        : c.pixelsPerMeter,
      cellW: fresh ? 512 : c.cellPx.w,
      cellH: fresh ? 512 : c.cellPx.h,
      paddingPx: fresh ? 72 : c.paddingPx,
      maxColors: s.maxColors,
      outlineWidthPx: s.outlineWidthPx,
      superSample: fresh ? 1 : overrides?.temporal?.superSample ?? s.row.superSample ?? 1,
      ambient: light.ambient,
      lightFrame: light.frame,
      lightYaw: Math.atan2(d[0]!, d[2]!) * 180 / Math.PI,
      lightElevation: Math.atan2(d[1]!, Math.hypot(d[0]!, d[2]!)) * 180 / Math.PI,
    };
  }, [cameras, styles, m.look, m.canonicalMesh?.heightM]);
  useEffect(() => {
    if (recorded && draft === null) setDraft(recorded);
  }, [recorded, draft]);
  const set = useCallback(
    (patch: Partial<LookDraft>) =>
      setDraft((current) => current ? { ...current, ...patch } : current),
    [],
  );
  const args = draft ? lookArgs(dir, draft, cameraBase, styleBase, m.look) : [];
  const previewArgs = [
    ...args,
    '--preview',
    '--clip',
    clipId,
    '--frame',
    String(frame),
    '--direction',
    String(direction),
  ];
  const requestRecipe = JSON.stringify(previewArgs);
  const stale = previewRecipe !== requestRecipe;
  const pixelZoom = !nativeSize && draft?.stylePresetId === 'pixel'
    ? Math.max(1, Math.floor(190 / draft.cellH))
    : 1;
  const dirty = !m.look || JSON.stringify(draft) !== JSON.stringify(recorded);
  const captureCamera = useMemo((): CaptureCamera | undefined =>
    draft
      ? ({
        ...cameraBase,
        id: draft.cameraPresetId,
        elevationDeg: draft.elevationDeg,
        yawOffsetDeg: (draft.yawOffsetDeg ?? 0) + direction * 360 / draft.directions,
        directions: draft.directions as 2 | 4 | 8 | 16,
        pixelsPerMeter: draft.pixelsPerMeter,
        cellPx: { w: draft.cellW, h: draft.cellH },
        paddingPx: draft.paddingPx ?? 16,
        orthographic: draft.orthographic ?? true,
        fovDeg: draft.fovDeg ?? 35,
        pivot: resolvedCamera(cameras, m.look, draft.cameraPresetId)?.pivot ?? 'feet-baseline',
      })
      : undefined, [draft, cameraBase, direction, cameras, m.look]);
  const aim = useCallback(
    (patch: { yawOffsetDeg: number; elevationDeg: number; pixelsPerMeter: number }) => {
      set({
        ...patch,
        yawOffsetDeg:
          ((patch.yawOffsetDeg - direction * 360 / (draft?.directions ?? 8)) % 360 + 360) % 360,
      });
    },
    [set, direction, draft?.directions],
  );

  const renderFrame = async () => {
    if (busy || !draft) return;
    setBusy(true);
    setError(null);
    setProgress(t('Preparing animation…'));
    let artifact: string | undefined;
    let failure: string | undefined;
    try {
      const result = await bridge.runCli([...previewArgs, '--json'], (line) => {
        try {
          const e = JSON.parse(line);
          if (e.t === 'artifact' && e.kind === 'look-preview') artifact = e.path;
          if (e.t === 'error') failure = e.message;
          if (e.t === 'progress' && live.current) setProgress(`${e.step} · ${e.done}/${e.total}`);
        } catch { /* Plain diagnostics remain in the log drawer. */ }
      });
      if (result.exitCode !== 0) {
        throw new Error(failure ?? t('Preview failed. Open logs for details, then retry.'));
      }
      const key = artifact?.replaceAll('\\', '/').split('/').at(-2);
      if (!key) throw new Error(t('No preview was produced. Run this action in the desktop app.'));
      const next = await bridge.readLookPreview(dir, key) as FramePreview | null;
      if (!next) throw new Error(t('Preview files are unavailable. Render the frame again.'));
      const png = await bridge.readImage(next.imagePath);
      if (!png) throw new Error(t('The rendered image could not be read. Render the frame again.'));
      if (live.current) {
        setPreview(next);
        setImage(png);
        setPreviewRecipe(requestRecipe);
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const record = async (go = false) => {
    if (busy || !draft) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.runCli([...args, '--json']);
      if (result.exitCode !== 0) throw new Error(t('The look was not saved. Open logs and retry.'));
      onChanged();
      if (go) onGoToStage('bake');
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const resizeCell = (w: number, h: number) => {
    if (!draft || w < 1 || h < 1 || w > 4096 || h > 4096) return;
    const ratio = Math.min(w / draft.cellW, h / draft.cellH);
    set({
      cellW: w,
      cellH: h,
      pixelsPerMeter: Math.max(1, Math.round(draft.pixelsPerMeter * ratio)),
      paddingPx: Math.round((draft.paddingPx ?? 16) * ratio),
    });
  };
  const number = (label: string, field: keyof LookDraft, min: number, max: number, step = 1) => (
    <label className='field'>
      {label}
      <input
        type='number'
        min={min}
        max={max}
        step={step}
        value={draft?.[field] as number ?? 0}
        onChange={(e) => {
          const v = e.currentTarget.valueAsNumber;
          if (Number.isFinite(v) && v >= min && v <= max) set({ [field]: v });
        }}
      />
    </label>
  );
  return (
    <div className='lookstage workbench-stage'>
      <div className='capture-workspace'>
        <div className='capture-scene'>
          <Viewport
            bridge={bridge}
            meshPath={preview?.meshPath ?? (m.canonicalMesh ? `${dir}/canonical/model.glb` : null)}
            contentKey={m.canonicalMesh?.gltfSha256}
            captureCamera={captureCamera}
            onCaptureChange={aim}
            sampleTime={preview?.time ?? 0}
          />
        </div>
        <section className='capture-output' aria-label={t('Rendered frame')}>
          <div className='capture-output-head'>
            <h2>{t('Rendered frame')}</h2>
            <span className='mono dimtext'>{draft?.cellW} × {draft?.cellH} px</span>
            <button
              className='btn mbtn'
              type='button'
              aria-pressed={nativeSize}
              onClick={() => setNativeSize((v) => !v)}
            >
              {nativeSize ? t('Fit preview') : t('Actual pixels')}
            </button>
          </div>
          <div
            className={`capture-flat ${
              nativeSize || draft?.stylePresetId === 'pixel' ? 'native-pixels' : ''
            }`}
          >
            {image
              ? (
                <img
                  src={image}
                  alt={t('Core-rendered sprite frame')}
                  style={draft?.stylePresetId === 'pixel'
                    ? { width: draft.cellW * pixelZoom, height: draft.cellH * pixelZoom }
                    : undefined}
                />
              )
              : (
                <p>
                  {t('Aim the camera, then render a frame to check the final lighting and style.')}
                </p>
              )}
          </div>
          <div className='capture-output-foot' role='status'>
            {busy
              ? progress
              : !image
              ? t('No frame rendered yet')
              : stale
              ? t('Settings changed · render to update')
              : t('Current frame · same renderer as Bake')}
            <button
              type='button'
              className='btn mbtn'
              disabled={busy || !draft}
              onClick={renderFrame}
            >
              {busy ? t('Rendering…') : t('Render frame')}
            </button>
          </div>
          {preview?.paletteProvisional && (
            <p className='inote'>
              {t(
                'Palette preview uses this frame. Bake builds one stable palette across the animation set.',
              )}
            </p>
          )}
          {preview?.flags.map((f, i) => (
            <p className='inote qa-warn' key={`${f.code}-${i}`}>{f.message}</p>
          ))}
        </section>
      </div>
      <Inspector>
        <div className='inspector-scroll'>
          {!draft
            ? <p className='control-section' role='status'>{t('Loading capture settings…')}</p>
            : (
              <>
                <section className='control-section capture-controls'>
                  <h2>{t('Camera')}</h2>
                  <div className='capture-views m-seg' role='group' aria-label={t('Camera setup')}>
                    <button
                      type='button'
                      className='btn mbtn'
                      onClick={() => {
                        set({ elevationDeg: 0, yawOffsetDeg: 90, directions: 2 });
                        setDirection(0);
                      }}
                    >
                      {t('Side-scroller')}
                    </button>
                    <button
                      type='button'
                      className='btn mbtn'
                      onClick={() => {
                        set({ elevationDeg: 35.264, yawOffsetDeg: 22.5, directions: 8 });
                        setDirection(0);
                      }}
                    >
                      {t('Isometric')}
                    </button>
                  </div>
                  <label className='field'>
                    {t('Projection')}
                    <select
                      value={draft.orthographic ? 'orthographic' : 'perspective'}
                      onChange={(e) => set({ orthographic: e.target.value === 'orthographic' })}
                    >
                      <option value='orthographic'>{t('Orthographic')}</option>
                      <option value='perspective'>{t('Perspective')}</option>
                    </select>
                  </label>
                  <div className='capture-field-pair'>
                    {number(t('Elevation'), 'elevationDeg', 0, 89, 0.1)}
                    {number(t('Turn'), 'yawOffsetDeg', 0, 360, 0.5)}
                  </div>
                  {!draft.orthographic && number(t('Field of view'), 'fovDeg', 10, 90)}
                  <div className='capture-field-pair'>
                    {number(t('Pixels per metre'), 'pixelsPerMeter', 1, 20000)}
                    <label className='field'>
                      {t('Directions')}
                      <select
                        value={draft.directions}
                        onChange={(e) => {
                          set({ directions: Number(e.target.value) });
                          setDirection(0);
                        }}
                      >
                        {[2, 4, 8, 16].map((d) => <option key={d}>{d}</option>)}
                      </select>
                    </label>
                  </div>
                  <p className='inote'>
                    {t(
                      'Orbit to aim. Scroll to change scale. The frame guide shows the capture area.',
                    )}
                  </p>
                </section>
                <section className='control-section capture-controls'>
                  <h2>{t('Lighting & finish')}</h2>
                  <label className='field'>
                    {t('Finish')}
                    <select
                      value={draft.stylePresetId}
                      onChange={(e) => {
                        const s = styles.find((s) => s.id === e.target.value);
                        if (s) {
                          set({
                            stylePresetId: s.id,
                            maxColors: s.maxColors,
                            outlineWidthPx: s.outlineWidthPx,
                          });
                        }
                      }}
                    >
                      {[...styles].sort((
                        a,
                        b,
                      ) => (a.id === 'clean'
                        ? -1
                        : b.id === 'clean'
                        ? 1
                        : a.id.localeCompare(b.id))
                      ).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.id === 'clean' ? t('Original · full color') : s.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className='capture-field-pair'>
                    {number(t('Light turn'), 'lightYaw', -180, 180)}
                    {number(t('Light height'), 'lightElevation', 0, 90)}
                  </div>
                  <label className='field'>
                    {t('Ambient fill')}
                    <input
                      type='range'
                      min='0'
                      max='1'
                      step='.05'
                      value={draft.ambient}
                      onChange={(e) => set({ ambient: Number(e.target.value) })}
                    />
                  </label>
                  <label className='field'>
                    {t('Light follows')}
                    <select
                      value={draft.lightFrame}
                      onChange={(e) => set({ lightFrame: e.target.value })}
                    >
                      <option value='camera'>{t('Camera')}</option>
                      <option value='world'>{t('World')}</option>
                    </select>
                  </label>
                  {styleBase?.maxColors !== undefined &&
                    number(t('Palette colors'), 'maxColors', 2, 256)}
                  {styleBase?.outlineWidthPx !== undefined &&
                    number(t('Outline pixels'), 'outlineWidthPx', .25, 8, .25)}
                </section>
                <section className='control-section capture-controls'>
                  <h2>{t('Output cell')}</h2>
                  <div className='capture-field-pair'>
                    <label className='field'>
                      {t('Width')}
                      <input
                        type='number'
                        min='1'
                        max='4096'
                        value={draft.cellW}
                        onChange={(e) => resizeCell(e.target.valueAsNumber, draft.cellH)}
                      />
                    </label>
                    <label className='field'>
                      {t('Height')}
                      <input
                        type='number'
                        min='1'
                        max='4096'
                        value={draft.cellH}
                        onChange={(e) => resizeCell(draft.cellW, e.target.valueAsNumber)}
                      />
                    </label>
                  </div>
                  <div className='capture-views m-seg' role='group' aria-label={t('Cell size')}>
                    {[64, 256, 512, 1024, 4096].map((size) => (
                      <button
                        type='button'
                        className='btn mbtn'
                        key={size}
                        aria-pressed={draft.cellW === size && draft.cellH === size}
                        onClick={() => resizeCell(size, size)}
                      >
                        {size === 4096 ? '4K' : size}
                      </button>
                    ))}
                  </div>
                  <div className='capture-field-pair'>
                    {number(
                      'Ground margin',
                      'paddingPx',
                      0,
                      Math.min(draft.cellW, draft.cellH) / 2 - 1,
                    )}
                    <label className='field'>
                      {t('Antialiasing')}
                      <select
                        value={draft.superSample}
                        onChange={(e) => set({ superSample: Number(e.target.value) })}
                      >
                        {[1, 2, 3, 4].map((s) => <option key={s} value={s}>{s}×</option>)}
                      </select>
                    </label>
                  </div>
                  <p className='inote'>
                    {t('Large cells and higher antialiasing increase GPU memory and bake time.')}
                  </p>
                </section>
                <section className='control-section capture-controls'>
                  <h2>{t('Preview sample')}</h2>
                  <label className='field'>
                    {t('Animation')}
                    <select
                      value={clipId}
                      onChange={(e) => {
                        setClipId(e.target.value);
                        setFrame(0);
                      }}
                    >
                      {clips.length
                        ? clips.map((c) => <option key={c.clipId}>{c.clipId}</option>)
                        : <option>walk-loop</option>}
                    </select>
                  </label>
                  <label className='field'>
                    {t('Frame')} {frame + 1} / {frames}
                    <input
                      type='range'
                      min='0'
                      max={frames - 1}
                      value={frame}
                      onChange={(e) => setFrame(Number(e.target.value))}
                    />
                  </label>
                  <label className='field'>
                    {t('Direction')}
                    <select
                      value={direction}
                      onChange={(e) => setDirection(Number(e.target.value))}
                    >
                      {Array.from(
                        { length: draft.directions },
                        (_, d) => (
                          <option key={d} value={d}>
                            {d + 1} ·{' '}
                            {Math.round((draft.yawOffsetDeg ?? 0) + d * 360 / draft.directions) %
                              360}°
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                </section>
              </>
            )}
        </div>
        <div className='control-section action-section capture-actions'>
          {error && <p className='mdl-error' role='alert'>{error}</p>}
          <button
            type='button'
            className='btn primary'
            disabled={busy || !draft}
            onClick={() => record(true)}
          >
            {t('Save look & bake animations')}
          </button>
          <button
            type='button'
            className='btn mbtn'
            disabled={busy || !draft || !dirty}
            onClick={() => record()}
          >
            {t('Save look')}
          </button>
          <details>
            <summary>{t('CLI commands')}</summary>
            <CliTwin args={args} />
            <CliTwin args={previewArgs} />
          </details>
        </div>
      </Inspector>
    </div>
  );
}
