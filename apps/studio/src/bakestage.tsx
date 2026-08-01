/**
 * Stage 05 (P4-T2): run the bake, then REVIEW it. Segmented progress in
 * core's own steps, cache % and flicker from the manifest's metrics, an ETA
 * that only speaks once it can, a sprite player over the real atlas (8
 * directions, transport, fps, AOV pass toggles — pages are rect-identical, so
 * one set of frame rects addresses them all), and QA flags that jump to the
 * stage that owns them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioBridge } from './bridge';
import {
  type BakeSummary,
  etaSeconds,
  flagStage,
  playFrames,
  readProgress,
  summarize,
} from './bakeprogress';
import type { StageKey } from './stages';
import { t } from './i18n';
import { CliTwin } from './gen';

const PASSES = ['lit', 'albedo', 'normal', 'depth', 'mask'] as const;

/* ---------------- the sprite player ---------------- */

function Player({ summary, atlasPng, pass, dir, clip, playing, fps, zoom }: {
  summary: BakeSummary;
  atlasPng: string;
  pass: string;
  dir: number;
  clip: string;
  playing: boolean;
  fps: number;
  zoom: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [at, setAt] = useState(0);
  const frames = playFrames(summary, clip, dir);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setAt((v) => v); // repaint with the new page
    };
    img.src = `data:image/png;base64,${atlasPng}`;
  }, [atlasPng]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const id = setInterval(() => setAt((v) => (v + 1) % frames.length), 1000 / fps);
    return () => clearInterval(id);
  }, [playing, fps, frames.length]);

  useEffect(() => setAt(0), [clip, dir]);

  useEffect(() => {
    const canvas = ref.current;
    const img = imgRef.current;
    const f = frames[Math.min(at, frames.length - 1)];
    if (!canvas || !img || !f) return;
    canvas.width = f.atlas.w * zoom;
    canvas.height = f.atlas.h * zoom;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false; // pixel truth
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      img,
      f.atlas.x,
      f.atlas.y,
      f.atlas.w,
      f.atlas.h,
      0,
      0,
      f.atlas.w * zoom,
      f.atlas.h * zoom,
    );
  }, [at, frames, zoom, pass, atlasPng]);

  return (
    <div className='player'>
      <div className='playerwell'>
        <canvas
          ref={ref}
          className='stripcanvas'
          role='img'
          aria-label={`${clip} ${t('direction')} ${dir} ${t('frame')} ${at + 1}/${frames.length}`}
        />
      </div>
      <div className='playermeta mono'>
        {t('frame')} {frames.length === 0 ? 0 : at + 1}/{frames.length} · {pass}
      </div>
    </div>
  );
}

/* ---------------- the stage ---------------- */

export function BakeStage({ bridge, dir, manifest, onChanged, onGoToStage }: {
  bridge: StudioBridge;
  dir: string;
  manifest: unknown;
  onChanged: () => void;
  onGoToStage: (stage: StageKey) => void;
}) {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const [summary, setSummary] = useState<BakeSummary | null>(null);
  const [atlasPng, setAtlasPng] = useState<string | null>(null);
  const [pass, setPass] = useState('lit');
  const [clip, setClip] = useState('');
  const [direction, setDirection] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [fps, setFps] = useState(8);
  const [zoom, setZoom] = useState(2);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ step: string; fraction: number } | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  const loadBake = useCallback(async (wantPass: string) => {
    const a = await bridge.readBakeAtlas(dir, wantPass);
    if (!a) {
      setSummary(null);
      setAtlasPng(null);
      return;
    }
    const s = summarize(a.manifest);
    setSummary(s);
    setAtlasPng(a.png);
    if (s && s.clips.length > 0) {
      setClip((cur) => (s.clips.includes(cur) ? cur : s.clips[0]!));
      setDirection((cur) => (s.directions.includes(cur) ? cur : s.directions[0]!));
    }
  }, [bridge, dir]);

  useEffect(() => {
    loadBake(pass);
  }, [loadBake, pass, m.lastBakeId]);

  const args = ['bake', '--workspace', dir];

  const runBake = useCallback(async () => {
    setRunning(true);
    setFailed(false);
    setProgress(null);
    setEta(null);
    const started = Date.now();
    const r = await bridge.runCli([...args, '--json'], (line) => {
      const p = readProgress(line);
      if (!p) return;
      setProgress({ step: p.step, fraction: p.fraction });
      setEta(etaSeconds((Date.now() - started) / 1000, p));
    });
    setRunning(false);
    setProgress(null);
    if (r.exitCode === 0) {
      await loadBake(pass);
      onChanged();
    } else setFailed(true);
  }, [bridge, args, loadBake, pass, onChanged]);

  return (
    <div className='bakestage'>
      <section className='gensec'>
        <div className='gensechead'>
          <span className='hud'>{t('Bake')}</span>
          <span className='ieyebrow mono'>05// BAKE</span>
        </div>
        <div className='genrow'>
          <button type='button' className='btn primary' disabled={running} onClick={runBake}>
            {running ? t('Baking…') : summary ? t('Re-bake') : t('Bake sheet')}
          </button>
          {running && progress && (
            <span className='bakeprogress' role='status'>
              <span className='segbar' aria-hidden='true'>
                {Array.from(
                  { length: 20 },
                  (_, i) => <i key={i} className={i / 20 < progress.fraction ? 'f' : ''} />,
                )}
              </span>
              <span className='mono'>
                {progress.step} · {Math.round(progress.fraction * 100)}%
                {eta !== null ? ` · ~${eta}s ${t('left')}` : ''}
              </span>
            </span>
          )}
          {failed && (
            <span className='mv-exit mono'>
              {t('failed — the log drawer has the verbatim reason')}
            </span>
          )}
        </div>
        <CliTwin args={args} />
      </section>

      {summary === null
        ? (
          <section className='gensec'>
            <div className='inote'>{t('no bake yet — run one to review it here')}</div>
          </section>
        )
        : (
          <>
            <section className='gensec'>
              <div className='gensechead'>
                <span className='hud'>{t('Review')}</span>
                <span className='mono dimtext'>
                  {t('bake')} {summary.bakeId} · {summary.frames.length} {t('frames')} ·{' '}
                  {t('cache')} {Math.round(summary.cacheHitPct)}% · {t('flicker')}{' '}
                  {summary.flickerPct.toFixed(2)}% · {summary.wallTimeS.toFixed(1)}s
                </span>
              </div>

              <div className='genrow'>
                <label htmlFor='playclip'>{t('Clip')}</label>
                <select
                  id='playclip'
                  className='optnum mono'
                  value={clip}
                  onChange={(e) => setClip(e.target.value)}
                >
                  {summary.clips.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <label id='dirlabel'>{t('Direction')}</label>
                <span className='m-seg' role='group' aria-labelledby='dirlabel'>
                  {summary.directions.map((d) => (
                    <button
                      key={d}
                      type='button'
                      className='btn mbtn'
                      aria-pressed={direction === d}
                      onClick={() => setDirection(d)}
                    >
                      d{d}
                    </button>
                  ))}
                </span>
              </div>

              <div className='genrow'>
                <button type='button' className='btn mbtn' onClick={() => setPlaying((v) => !v)}>
                  {playing ? `⏸ ${t('Pause')}` : `▶ ${t('Play')}`}
                </button>
                <label htmlFor='playfps'>{t('fps')}</label>
                <input
                  id='playfps'
                  type='number'
                  className='optnum mono cellnum'
                  min={1}
                  max={60}
                  value={fps}
                  onChange={(e) => setFps(Number(e.target.value) || 1)}
                />
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
                <span className='m-seg' role='group' aria-label={t('Pass')}>
                  {PASSES.filter((p) => summary.passes.includes(p)).map((p) => (
                    <button
                      key={p}
                      type='button'
                      className='btn mbtn'
                      aria-pressed={pass === p}
                      onClick={() => setPass(p)}
                    >
                      {p}
                    </button>
                  ))}
                </span>
              </div>

              {atlasPng && (
                <Player
                  summary={summary}
                  atlasPng={atlasPng}
                  pass={pass}
                  dir={direction}
                  clip={clip}
                  playing={playing}
                  fps={fps}
                  zoom={zoom}
                />
              )}
              <div className='inote'>
                {t('nearest-neighbor · integer zoom · AOV pages share the lit layout')}
              </div>
            </section>

            <section className='gensec'>
              <div className='gensechead'>
                <span className='hud'>{t('Quality flags')}</span>
              </div>
              {summary.flags.length === 0
                ? <div className='inote'>{t('this bake raised no flags')}</div>
                : (
                  <div className='qaflags'>
                    {summary.flags.map((f, i) => (
                      <div key={`${f.code}-${i}`} className='qaflag'>
                        <span
                          className={`mbadge ${f.severity === 'error' ? 'signal' : 'gate'}`}
                        >
                          {f.code}
                        </span>
                        <span className='qamsg'>{f.message}</span>
                        <button
                          type='button'
                          className='btn mbtn'
                          onClick={() => onGoToStage(flagStage(f) as StageKey)}
                        >
                          {t('Open')} {flagStage(f)}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
            </section>
          </>
        )}
    </div>
  );
}
