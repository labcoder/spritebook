import type { Stage, StageKey } from './stages';
import { t } from './i18n';

/** Literal t() per key — the extractor refuses ids it cannot see statically. */
export function stageLabel(k: StageKey): string {
  switch (k) {
    case 'gen':
      return t('Generate');
    case 'rig':
      return t('Rig');
    case 'anim':
      return t('Animate');
    case 'look':
      return t('Look');
    case 'bake':
      return t('Bake');
    case 'export':
      return t('Export');
  }
}

export function StageRail({ stages, active, onSelect }: {
  stages: Stage[];
  active: StageKey;
  onSelect: (k: StageKey) => void;
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
          <span className='nm hud'>{stageLabel(s.key)}</span>
          <i className={`dot ${s.state}`} aria-hidden='true' />
          {s.state === 'locked' && <span className='sr-only'>{t('locked')} — {s.note}</span>}
        </button>
      ))}
    </nav>
  );
}
