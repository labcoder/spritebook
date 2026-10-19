import { useJobBridge } from './jobscope';
/**
 * The editor frame for one open character: stage rail (hue chips, lock
 * states), canvas well (core-produced pixels at integer zoom, dark checker
 * in both themes), and the read-only inspector behind a resizable grip.
 * No editing verbs exist here yet — every panel is a projection of the
 * manifest, and says so.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioBridge } from './bridge';
import type { CharacterCard } from './manifest';
import { Candidates } from './gen';
import { RigStage } from './rigstage';
import { AnimStage } from './animstage';
import { LookStage } from './lookstage';
import { BakeStage } from './bakestage';
import { ExportStage } from './exportstage';
import { type Stage, type StageKey, stageStates } from './stages';
import { t } from './i18n';
import { prefs } from './prefs';

/* ---------------- stage rail ---------------- */

/** Literal t() per key — the extractor refuses ids it cannot see statically. */
function stageLabel(k: StageKey): string {
  switch (k) {
    case 'gen':
      return t('Gen');
    case 'rig':
      return t('Rig');
    case 'anim':
      return t('Anim');
    case 'look':
      return t('Look');
    case 'bake':
      return t('Bake');
    case 'export':
      return t('Export');
  }
}

function StageRail({ stages, active, onSelect, busy, onCancel }: {
  stages: Stage[];
  active: StageKey;
  onSelect: (k: StageKey) => void;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <nav className='rail' aria-label={t('Pipeline stages')}>
      {stages.map((s) => (
        // aria-disabled, not disabled: a hard-disabled stage is skipped by
        // Tab, so keyboard users could never reach the one place its lock
        // REASON lives. Locked stages stay focusable, announce the reason,
        // and simply do not switch (walkthrough finding).
        <button
          key={s.key}
          type='button'
          className={`stage st-${s.state} ${s.key === active ? 'on' : ''}`}
          aria-current={s.key === active ? 'step' : undefined}
          aria-disabled={s.state === 'locked'}
          title={s.note}
          onClick={() => {
            if (s.state !== 'locked') onSelect(s.key);
          }}
        >
          <span className='n mono'>{s.n}</span>
          <i className='hue' style={{ background: `var(${s.hueVar})` }} />
          <span className='nm hud'>{stageLabel(s.key)}</span>
          <i className={`dot ${s.state}`} aria-hidden='true' />
          {s.state === 'locked' && <span className='sr-only'>{t('locked')} — {s.note}</span>}
        </button>
      ))}
      {busy && (
        <button
          type='button'
          className='btn'
          onClick={onCancel}
          title='CLI: Ctrl+C'
        >
          {t('Cancel job')} <kbd>Ctrl+C</kbd>
        </button>
      )}
      <div className='railnote'>
        {stages.some((s) => s.state === 'locked')
          ? t('stages unlock when a canonical mesh is saved')
          : ''}
      </div>
    </nav>
  );
}

/* ---------------- canvas well ---------------- */

const ZOOMS = [1, 2, 4] as const;

function CanvasWell(
  { bridge, card }: { bridge: StudioBridge; card: CharacterCard },
) {
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [zoom, setZoom] = useState<number>(2);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let live = true;
    setSrc(null);
    setMissing(false);
    setNat(null);
    bridge.readThumb(card.dir).then((s) => {
      if (!live) return;
      if (s) setSrc(s);
      else setMissing(true);
    }, () => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [bridge, card.dir]);

  return (
    <div className='center'>
      <div className='canvashead'>
        <span className='hud'>{t('preview')}</span>
        <span className='mono dimtext'>
          {card.lastBakeId
            ? `${t('bake')} ${card.lastBakeId} · ${t('contact strip')}`
            : t('no bake recorded')}
        </span>
        <div className='zoom' role='group' aria-label={t('Zoom')}>
          {ZOOMS.map((z) => (
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
      <div className='well'>
        {src
          ? (
            <img
              src={src}
              alt={`${card.displayName} — ${t('contact strip')}`}
              onLoad={(e) => {
                const el = e.currentTarget;
                setNat({ w: el.naturalWidth, h: el.naturalHeight });
              }}
              style={nat ? { width: nat.w * zoom, height: nat.h * zoom } : { visibility: 'hidden' }}
            />
          )
          : (
            <span className='nothumb mono'>
              {missing ? t('no bake yet — the well shows core output only') : '…'}
            </span>
          )}
        <span className='wellnote mono'>
          {t('nearest-neighbor · integer zoom · core output')}
        </span>
      </div>
    </div>
  );
}

/* ---------------- inspector (read-only projections) ---------------- */

function Rows({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj).filter(([, v]) =>
    v === null || ['string', 'number', 'boolean'].includes(typeof v)
  );
  if (entries.length === 0) {
    return <div className='inote'>{t('nothing recorded')}</div>;
  }
  return (
    <>
      {entries.map(([k, v]) => (
        <div className='irow' key={k}>
          <span className='ikey'>{k}</span>
          <span className='ival mono'>{String(v)}</span>
        </div>
      ))}
    </>
  );
}

function sliceFor(stage: StageKey, manifest: unknown): Record<string, unknown> {
  const m = (manifest !== null && typeof manifest === 'object' ? manifest : {}) as Record<
    string,
    unknown
  >;
  switch (stage) {
    case 'gen': {
      const g = (m.generation ?? {}) as Record<string, unknown>;
      const mesh = (m.canonicalMesh ?? {}) as Record<string, unknown>;
      return {
        pickedResultId: g.pickedResultId ?? null,
        results: Array.isArray(g.results) ? g.results.length : 0,
        ...mesh,
      };
    }
    case 'rig':
      return (m.rig ?? {}) as Record<string, unknown>;
    case 'anim': {
      const set = Array.isArray(m.animationSet) ? m.animationSet : [];
      return {
        bindings: set.length,
        enabled: (set as { enabled?: boolean }[]).filter((b) => b.enabled === true)
          .length,
      };
    }
    case 'look':
      return (m.look ?? {}) as Record<string, unknown>;
    case 'bake':
      return { lastBakeId: m.lastBakeId ?? null };
    case 'export':
      return (m.export ?? {}) as Record<string, unknown>;
  }
}

function Inspector({ stage, stages, manifest, dir }: {
  stage: StageKey;
  stages: Stage[];
  manifest: unknown;
  dir: string;
}) {
  const s = stages.find((x) => x.key === stage)!;
  return (
    <aside className='insp' aria-label={t('Inspector')}>
      <div className='isec'>
        <div className='isechead'>
          <span className='hud'>{stageLabel(stage)}</span>
          <span className='ieyebrow mono'>
            {`${s.n}// ${stage.toUpperCase()}`}
          </span>
        </div>
        <div className='inote'>{s.note}</div>
        <Rows obj={sliceFor(stage, manifest)} />
      </div>
      <div className='isec ifoot'>
        <div className='inote'>
          {t('read-only — every value here is the manifest')}
        </div>
        <div className='ival mono ipath' title={dir}>{dir}</div>
      </div>
    </aside>
  );
}

/* ---------------- the grip ---------------- */

const INSP_MIN = 240;
const INSP_MAX = 480;
const INSP_DEFAULT = 300;

function useInspectorWidth(): [number, (w: number) => void] {
  const [w, setW] = useState(() => prefs.inspectorWidth(INSP_DEFAULT, INSP_MIN, INSP_MAX));
  const set = useCallback((next: number) => {
    const clamped = Math.min(INSP_MAX, Math.max(INSP_MIN, Math.round(next)));
    setW(clamped);
    prefs.setInspectorWidth(clamped);
  }, []);
  return [w, set];
}

function Grip(
  { width, setWidth }: { width: number; setWidth: (w: number) => void },
) {
  const dragging = useRef<{ startX: number; startW: number } | null>(null);

  return (
    <div
      className='grip'
      role='separator'
      aria-orientation='vertical'
      aria-label={t('Resize inspector')}
      aria-valuemin={INSP_MIN}
      aria-valuemax={INSP_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = { startX: e.clientX, startW: width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        setWidth(
          dragging.current.startW + (dragging.current.startX - e.clientX),
        );
      }}
      onPointerUp={() => {
        dragging.current = null;
      }}
      onDoubleClick={() => setWidth(INSP_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setWidth(width + 16);
        else if (e.key === 'ArrowRight') setWidth(width - 16);
        else if (e.key === 'Home') setWidth(INSP_MAX);
        else if (e.key === 'End') setWidth(INSP_MIN);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/* ---------------- the frame ---------------- */

export function Editor(
  { bridge: baseBridge, card, manifest, onChanged, onOpenModels, catalogEpoch }: {
    bridge: StudioBridge;
    card: CharacterCard;
    manifest: unknown;
    /** a verb changed the manifest — the projections must re-read */
    onChanged: () => void;
    /** the Generate-more panel and failure banners open Manage models from here */
    onOpenModels: () => void;
    catalogEpoch?: number;
  },
) {
  const stages = stageStates(manifest);
  // 'gen', not 'look': the old default sat masked behind the locked-stage
  // fallback and TELEPORTED the user two stages ahead the instant a pick
  // unlocked the rail (UX pass 2, F10)
  const [active, setActive] = useState<StageKey>('gen');
  const [inspW, setInspW] = useInspectorWidth();
  // an active stage can become locked when switching characters — fall back
  const activeStage = stages.find((s) => s.key === active);
  const effective = activeStage && activeStage.state !== 'locked' ? active : 'gen';
  const { bridge, busy, cancel } = useJobBridge(
    baseBridge,
    `${card.dir}|${effective}|${JSON.stringify(manifest)}`,
  );

  // picking a canonical advances the rail to the NEXT stage in order - the
  // journey continues at Rig, not wherever a default happened to point. On
  // EVERY pick, not just the first: a re-picked canonical needs a re-rig,
  // so Rig is the next stage either way.
  const canonicalSha = String(
    ((manifest ?? {}) as { canonicalMesh?: { gltfSha256?: string } })
      .canonicalMesh
      ?.gltfSha256 ?? '',
  );
  const prevSha = useRef(canonicalSha);
  useEffect(() => {
    if (
      prevSha.current !== canonicalSha && canonicalSha !== '' &&
      active === 'gen'
    ) {
      setActive('rig');
    }
    prevSha.current = canonicalSha;
  }, [canonicalSha, active]);

  // `effective` can change WITHOUT a user act: the pick unlocks Look and the
  // default kicks in, or a character switch re-locks the active stage. Either
  // way the whole panel — possibly holding focus — unmounts. If the switch
  // orphaned focus onto <body>, land it on the new panel; if focus survived
  // (a rail click keeps it on the rail), leave it alone (walkthrough finding).
  const prevEffective = useRef(effective);
  useEffect(() => {
    if (prevEffective.current === effective) return;
    prevEffective.current = effective;
    const raf = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) {
        return;
      }
      const panel = document.querySelector<HTMLElement>('.center');
      if (panel) {
        panel.tabIndex = -1;
        panel.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [effective]);

  return (
    <div className='editor'>
      <StageRail
        stages={stages}
        active={effective}
        onSelect={setActive}
        busy={busy}
        onCancel={cancel}
      />
      {effective === 'gen'
        ? (
          <div className='center genstage'>
            <Candidates
              bridge={bridge}
              onOpenModels={onOpenModels}
              catalogEpoch={catalogEpoch}
              dir={card.dir}
              manifest={manifest}
              onChanged={onChanged}
            />
          </div>
        )
        : effective === 'rig'
        ? (
          <div className='center genstage'>
            <RigStage
              bridge={bridge}
              dir={card.dir}
              manifest={manifest}
              onChanged={onChanged}
            />
          </div>
        )
        : effective === 'anim'
        ? (
          <div className='center genstage'>
            <AnimStage
              bridge={bridge}
              dir={card.dir}
              manifest={manifest}
              onChanged={onChanged}
            />
          </div>
        )
        : effective === 'look'
        ? (
          <div className='center genstage'>
            <LookStage
              bridge={bridge}
              dir={card.dir}
              manifest={manifest}
              onChanged={onChanged}
            />
          </div>
        )
        : effective === 'bake'
        ? (
          <div className='center genstage'>
            <BakeStage
              bridge={bridge}
              dir={card.dir}
              manifest={manifest}
              onChanged={onChanged}
              onGoToStage={setActive}
            />
          </div>
        )
        : effective === 'export'
        ? (
          <div className='center genstage'>
            <ExportStage
              bridge={bridge}
              dir={card.dir}
              manifest={manifest}
              onChanged={onChanged}
            />
          </div>
        )
        : <CanvasWell bridge={bridge} card={card} />}
      <Grip width={inspW} setWidth={setInspW} />
      <div style={{ width: inspW }} className='inspwrap'>
        <Inspector
          stage={effective}
          stages={stages}
          manifest={manifest}
          dir={card.dir}
        />
      </div>
    </div>
  );
}
