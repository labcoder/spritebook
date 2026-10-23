import { useJobBridge } from './jobscope';
/** Six-stage frame over CLI-backed editing; stage controls project CLI-backed behavior. */
import { useEffect, useRef, useState } from 'react';
import type { StudioBridge } from './bridge';
import type { CharacterCard } from './manifest';
import { Candidates } from './gen';
import { RigStage } from './rigstage';
import { AnimStage } from './animstage';
import { LookStage } from './lookstage';
import { BakeStage } from './bakestage';
import { ExportStage } from './exportstage';
import { type StageKey, stageStates } from './stages';
import { StageRail } from './stagerail';
import { t } from './i18n';
import { Workbench } from './workbench';

/* ---------------- the frame ---------------- */

export function Editor(
  { bridge: baseBridge, card, manifest, onChanged, onOpenModels, catalogEpoch }: {
    bridge: StudioBridge;
    card: CharacterCard;
    manifest: unknown;
    /** a verb changed the manifest — the projections must re-read */
    onChanged: () => void;
    /** the Generate-more panel and failure banners open Manage extensions from here */
    onOpenModels: () => void;
    catalogEpoch?: number;
  },
) {
  const stages = stageStates(manifest);
  // 'gen', not 'look': the old default sat masked behind the locked-stage
  // fallback and TELEPORTED the user two stages ahead the instant a pick
  // unlocked the rail (UX pass 2, F10)
  const [active, setActive] = useState<StageKey>('gen');
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

  return (
    <div className='editor'>
      <StageRail
        stages={stages}
        active={effective}
        onSelect={setActive}
      />
      <Workbench
        title={card.displayName}
        actions={busy && (
          <button type='button' className='btn' onClick={cancel} title='CLI: Ctrl+C'>
            {t('Cancel job')}
          </button>
        )}
      >
        <div className={`center genstage stage-${effective}`}>
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
                onGoToStage={setActive}
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
      </Workbench>
    </div>
  );
}
