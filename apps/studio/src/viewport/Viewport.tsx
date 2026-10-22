/**
 * The thin React seam: it owns a container element and a MeshViewport, and
 * knows nothing else about three.js (the skill's architecture stance). Every
 * control below is a button over the class's API.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioBridge } from '../bridge';
import { MeshViewport, type NudgeEvent, type ViewMode } from './meshviewport';
import { t } from '../i18n';
import { scrollIntoViewPolitely } from '../focus';

const MODES: ViewMode[] = ['textured', 'clay', 'wire'];

export function Viewport(
  {
    bridge,
    meshPath,
    contentKey,
    focusJoint,
    showSkeleton,
    flaggedJoints,
    previewYaw = 0,
    onNudge,
    onJointSelected,
    height,
  }: {
    bridge: StudioBridge;
    /** canonical glTF in the workspace — never a raw upload */
    meshPath: string | null;
    /** Changes when the BYTES behind meshPath change. The pick and the rig
     * both rewrite `canonical/model.glb` IN PLACE, so a path-keyed load kept
     * showing the old mesh after "Save as canonical mesh" — the maintainer's
     * UX pass saw r2 with r3 picked. The manifest's `canonicalMesh.gltfSha256`
     * is re-pinned on every promotion, so callers pass that. */
    contentKey?: string;
    /** Select-and-frame this joint in the canvas. The counter `n` makes the
     * SAME joint focusable twice in a row — a plain string prop would eat the
     * second click as "no change". */
    focusJoint?: { name: string; n: number } | null;
    showSkeleton?: boolean;
    flaggedJoints?: readonly string[];
    previewYaw?: number;
    onNudge?: (e: NudgeEvent) => void;
    onJointSelected?: (joint: string | null) => void;
    height?: number;
  },
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<MeshViewport | null>(null);
  const [skeletonVisible, setSkeletonVisible] = useState(true);
  const [throughMesh, setThroughMesh] = useState(true);
  const readMesh = bridge.readMesh;
  const [mode, setMode] = useState<ViewMode>('textured');
  const [vpReady, setVpReady] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // transport state mirrors the class (D-038: playback, never synthesis)
  const [animDuration, setAnimDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [atime, setAtime] = useState(0);
  // keep the callbacks fresh without re-creating the viewport
  const nudgeRef = useRef(onNudge);
  nudgeRef.current = onNudge;
  const selRef = useRef(onJointSelected);
  selRef.current = onJointSelected;

  useEffect(() => {
    vpRef.current?.setJointEditing(onNudge !== undefined);
  }, [onNudge !== undefined, vpReady]);

  useEffect(() => {
    vpRef.current?.setPreviewYaw(previewYaw);
    vpRef.current?.renderOnce();
  }, [previewYaw, vpReady, state]);

  useEffect(() => {
    let live = true;
    let vp: MeshViewport | null = null;
    const host = hostRef.current;
    if (!host) return;
    MeshViewport.create(host).then((v) => {
      if (!live) {
        v.dispose();
        return;
      }
      vp = v;
      vpRef.current = v;
      setVpReady(true);
      v.on('jointNudged', (e) => nudgeRef.current?.(e));
      v.on('jointSelected', (j) => {
        setSelected(j);
        selRef.current?.(j);
      });
      // a render-loop throw must be VISIBLE, not just a dataset attribute:
      // UX pass 2 watched a transport play over an empty canvas because the
      // pipeline error only reached the in-pane checks (F16a)
      v.on('error', (message) => {
        setState('error');
        setError(t('the canvas failed to draw: ') + message);
      });
      setState('idle');
    }, (err) => {
      if (!live) return;
      setState('error');
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      live = false;
      vp?.dispose();
      vpRef.current = null;
      setVpReady(false);
    };
  }, []);

  useEffect(() => {
    const vp = vpRef.current;
    if (!vpReady || !vp || !meshPath) return;
    let live = true;
    setState('loading');
    setError(null);
    readMesh(meshPath).then(async (b64) => {
      if (!live) return;
      if (b64 === null) {
        setState('error');
        setError(t('that mesh is not on disk yet'));
        return;
      }
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      try {
        const loaded = await vp.load(bytes.buffer);
        if (!live || !loaded) return;
        vp.renderOnce();
        if (live) {
          setState('ready');
          setAnimDuration(vp.animationDuration);
          setPlaying(vp.animationPlaying);
          setAtime(0);
        }
      } catch (err) {
        if (!live) return;
        setState('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    }, (err) => {
      if (!live) return;
      setState('error');
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      live = false;
      vp.cancelLoad();
    };
    // contentKey re-runs the load when the bytes behind an UNCHANGED path
    // change (in-place canonical rewrites) - see the prop's comment
  }, [readMesh, meshPath, contentKey, vpReady]);

  useEffect(() => {
    vpRef.current?.setSkeletonVisible(showSkeleton === true && skeletonVisible);
    vpRef.current?.setThroughMesh(throughMesh);
    vpRef.current?.setFlaggedJoints(flaggedJoints ?? []);
    vpRef.current?.renderOnce();
  }, [showSkeleton, skeletonVisible, throughMesh, flaggedJoints, vpReady, state]);

  // the deform report drives the canvas: a row's activation lands here. The
  // polite scroll makes the gesture VISIBLE when the layout has stacked the
  // canvas below the fold (W5c) - a no-op when it is already on screen.
  useEffect(() => {
    if (!focusJoint || state !== 'ready') return;
    vpRef.current?.focusJoint(focusJoint.name);
    scrollIntoViewPolitely(hostRef.current);
  }, [focusJoint, state]);

  // the renderer's counters, mirrored onto the host as data attributes: the
  // canvas cannot be read back (cleared after present), so this is how the
  // in-pane checks and the leak assertion see whether it is really drawing
  useEffect(() => {
    if (state !== 'ready') return;
    const host = hostRef.current;
    const id = setInterval(() => {
      const s = vpRef.current?.stats();
      if (!host || !s) return;
      host.dataset.vpGeometries = String(s.geometries);
      host.dataset.vpTextures = String(s.textures);
      host.dataset.vpCalls = String(s.calls);
      host.dataset.vpTriangles = String(s.triangles);
      host.dataset.vpFrames = String(s.frames);
      host.dataset.vpChildren = String(s.sceneChildren);
      if (s.lastError) host.dataset.vpError = s.lastError;
    }, 400);
    return () => clearInterval(id);
  }, [state]);

  // the scrub thumb follows the mixer while it plays; paused, the user owns it
  useEffect(() => {
    if (state !== 'ready' || animDuration <= 0 || !playing) return;
    const id = setInterval(() => {
      const vp = vpRef.current;
      if (vp) setAtime(vp.animationTime);
    }, 150);
    return () => clearInterval(id);
  }, [state, animDuration, playing]);

  const apply = useCallback((m: ViewMode) => {
    setMode(m);
    vpRef.current?.setMode(m);
    vpRef.current?.renderOnce(); // the rAF loop is paused while hidden
  }, []);

  return (
    <div className='vpwrap'>
      <div className='vpbar'>
        <span className='m-seg' role='group' aria-label={t('Display mode')}>
          {MODES.map((m) => (
            <button
              key={m}
              type='button'
              className='btn mbtn'
              aria-pressed={mode === m}
              onClick={() => apply(m)}
            >
              {m === 'textured' ? t('Textured') : m === 'clay' ? t('Clay') : t('Wire')}
            </button>
          ))}
        </span>
        <button
          type='button'
          className='btn mbtn'
          onClick={() => vpRef.current?.frame()}
        >
          {t('Frame')}
        </button>
        <span className='m-seg' role='group' aria-label={t('Camera view')}>
          <button
            type='button'
            className='btn mbtn'
            onClick={() => vpRef.current?.setView('front')}
          >
            {t('Front')}
          </button>
          <button type='button' className='btn mbtn' onClick={() => vpRef.current?.setView('side')}>
            {t('Side')}
          </button>
          <button type='button' className='btn mbtn' onClick={() => vpRef.current?.setView('back')}>
            {t('Rear')}
          </button>
        </span>
        {showSkeleton && (
          <>
            <label className='check-field'>
              <input
                type='checkbox'
                checked={skeletonVisible}
                onChange={(e) => setSkeletonVisible(e.target.checked)}
              />
              {t('Skeleton')}
            </label>
            <label className='check-field'>
              <input
                type='checkbox'
                checked={throughMesh}
                onChange={(e) => setThroughMesh(e.target.checked)}
              />
              {t('Through mesh')}
            </label>
          </>
        )}
        {showSkeleton && selected && (
          <span className='mono dimtext'>
            {`${t('joint')}: ${selected}`}
          </span>
        )}
        <span className='mono dimtext vphint'>{t('orbit drag · dolly wheel · F frames')}</span>
      </div>
      <div
        ref={hostRef}
        className='vphost'
        style={height ? { height } : undefined}
        role='application'
        aria-label={t('Mesh inspection viewport')}
      />
      {state === 'ready' && animDuration > 0 && (
        <div className='vptransport'>
          <button
            type='button'
            className='btn mbtn'
            onClick={() => {
              const vp = vpRef.current;
              if (!vp) return;
              const next = !playing;
              vp.setAnimationPlaying(next);
              setPlaying(next);
            }}
          >
            {playing ? t('Pause') : t('Play')}
          </button>
          <input
            type='range'
            min={0}
            max={animDuration}
            step={0.05}
            value={atime}
            aria-label={t('Scrub the clip')}
            onChange={(e) => {
              const tSec = Number(e.currentTarget.value);
              vpRef.current?.seekAnimation(tSec);
              setAtime(tSec);
            }}
          />
          <span className='mono dimtext'>
            {atime.toFixed(1)}s / {animDuration.toFixed(1)}s
          </span>
        </div>
      )}
      {state !== 'ready' && (
        <div className='vpstate inote'>
          {state === 'loading'
            ? t('loading the mesh…')
            : state === 'error'
            ? error
            : meshPath === null
            ? t('nothing selected')
            : !vpReady
            ? t('starting the viewport…')
            : t('nothing selected')}
        </div>
      )}
      <div className='inote'>
        {t('an inspection instrument — the sprites come from core, never from here')}
      </div>
    </div>
  );
}
