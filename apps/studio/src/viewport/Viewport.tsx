/**
 * The thin React seam: it owns a container element and a MeshViewport, and
 * knows nothing else about three.js (the skill's architecture stance). Every
 * control below is a button over the class's API.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioBridge } from '../bridge';
import { MeshViewport, type NudgeEvent, type ViewMode } from './meshviewport';
import { t } from '../i18n';

const MODES: ViewMode[] = ['textured', 'clay', 'wire'];

export function Viewport({ bridge, meshPath, showSkeleton, onNudge, onJointSelected, height }: {
  bridge: StudioBridge;
  /** canonical glTF in the workspace — never a raw upload */
  meshPath: string | null;
  showSkeleton?: boolean;
  onNudge?: (e: NudgeEvent) => void;
  onJointSelected?: (joint: string | null) => void;
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<MeshViewport | null>(null);
  const [mode, setMode] = useState<ViewMode>('textured');
  const [vpReady, setVpReady] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // keep the callbacks fresh without re-creating the viewport
  const nudgeRef = useRef(onNudge);
  nudgeRef.current = onNudge;
  const selRef = useRef(onJointSelected);
  selRef.current = onJointSelected;

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
    bridge.readMesh(meshPath).then(async (b64) => {
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
        await vp.load(bytes.buffer);
        vp.renderOnce();
        if (live) setState('ready');
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
    };
  }, [bridge, meshPath, vpReady]);

  useEffect(() => {
    vpRef.current?.setSkeletonVisible(showSkeleton === true);
    vpRef.current?.renderOnce();
  }, [showSkeleton, vpReady, state]);

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
        {showSkeleton && (
          <span className='mono dimtext'>
            {selected ? `${t('joint')}: ${selected}` : t('click a joint to select it')}
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
