import { useJobBridge } from './jobscope';
/** Six-stage frame over CLI-backed editing; the inspector is a read-only projection. */
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
import { stageLabel, StageRail } from './stagerail';
import { t } from './i18n';
import { prefs } from './prefs';

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
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // an active stage can become locked when switching characters — fall back
  const activeStage = stages.find((s) => s.key === active);
  const effective = activeStage && activeStage.state !== 'locked' ? active : 'gen';
  const { bridge, busy, cancel } = useJobBridge(
    baseBridge,
    `${card.dir}|${effective}|${JSON.stringify(manifest)}`,
    onChanged,
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

  const heading = (
    <div className='editorheading'>
      <h1>{stageLabel(effective)}</h1>
      <p>{card.displayName}</p>
    </div>
  );
  const inspectorToggle = (
    <div className='editor-tools'>
      {busy && (
        <button type='button' className='btn' onClick={cancel} title='CLI: Ctrl+C'>
          {t('Cancel job')}
        </button>
      )}
      <button
        type='button'
        className='btn inspector-toggle'
        aria-expanded={inspectorOpen}
        aria-controls='character-inspector'
        onClick={() => setInspectorOpen((open) => !open)}
      >
        {t('Inspector')}
      </button>
    </div>
  );

  return (
    <div className='editor'>
      <StageRail
        stages={stages}
        active={effective}
        onSelect={setActive}
      />
      <div
        className={`editorbody ${
          effective === 'gen' || effective === 'rig' ? 'workbench-body' : ''
        }`}
      >
        <div className={`center genstage stage-${effective}`}>
          {effective !== 'look' && (
            <header className='editorhead'>{heading}{inspectorToggle}</header>
          )}
          {effective === 'gen'
            ? (
              <Candidates
                bridge={bridge}
                onOpenModels={onOpenModels}
                catalogEpoch={catalogEpoch}
                dir={card.dir}
                manifest={manifest}
                onChanged={onChanged}
              />
            )
            : effective === 'rig'
            ? <RigStage bridge={bridge} dir={card.dir} manifest={manifest} onChanged={onChanged} />
            : effective === 'anim'
            ? <AnimStage bridge={bridge} dir={card.dir} manifest={manifest} onChanged={onChanged} />
            : effective === 'look'
            ? (
              <LookStage
                bridge={bridge}
                dir={card.dir}
                manifest={manifest}
                onChanged={onChanged}
                heading={heading}
                inspectorToggle={inspectorToggle}
              />
            )
            : effective === 'bake'
            ? (
              <BakeStage
                bridge={bridge}
                dir={card.dir}
                manifest={manifest}
                onChanged={onChanged}
                onGoToStage={setActive}
              />
            )
            : (
              <ExportStage
                bridge={bridge}
                dir={card.dir}
                manifest={manifest}
                onChanged={onChanged}
              />
            )}
        </div>
        {inspectorOpen && (
          <>
            <Grip width={inspW} setWidth={setInspW} />
            <div id='character-inspector' style={{ width: inspW }} className='inspwrap'>
              <Inspector stage={effective} stages={stages} manifest={manifest} dir={card.dir} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
