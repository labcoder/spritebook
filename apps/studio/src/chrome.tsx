/**
 * The window chrome: menu bar, character tabs, status bar, log drawer.
 * All read-only projections; the drawer renders relayed CLI lines VERBATIM.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Menu } from '@base-ui/react/menu';
import { t } from './i18n';
import { log, type Severity } from './log';

/* ---------------- menu bar ---------------- */

export function MenuBar({ theme, locale, gpu, onToggleTheme, onToggleLocale, onReload, onExam }: {
  theme: string;
  locale: string;
  gpu: string | null;
  onToggleTheme: () => void;
  onToggleLocale: () => void;
  onReload: () => void;
  onExam: () => void;
}) {
  return (
    <header className='menubar'>
      <div className='logo'>
        <div className='logomark' aria-hidden='true'>
          <i />
          <i />
          <i />
          <i />
        </div>
        <span className='wordmark'>SPRITEBOOK</span>
      </div>
      <Menu.Root>
        <Menu.Trigger className='menubtn'>{t('File')}</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4}>
            <Menu.Popup className='menupop'>
              <Menu.Item className='menuitem' onClick={onReload}>{t('Reload gallery')}</Menu.Item>
              <Menu.Item className='menuitem' onClick={onExam}>{t('Run health exam')}</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <div className='menur'>
        <button
          type='button'
          className='chip'
          onClick={onToggleLocale}
          aria-label={t('Switch language')}
        >
          {t('lang')}: {locale}
        </button>
        <button type='button' className='chip' onClick={onToggleTheme}>
          {t('theme')}: {theme}
        </button>
        <span className='chip'>{gpu ? <b>{gpu}</b> : t('gpu: unexamined')}</span>
      </div>
    </header>
  );
}

/* ---------------- character tabs ---------------- */

export interface TabItem {
  id: string;
  label: string;
}

export function Tabs({ tabs, active, onSelect, onClose }: {
  tabs: TabItem[];
  active: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // roving arrows per the tabs pattern; Home/End for completeness
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const ids = tabs.map((x) => x.id);
    const at = ids.indexOf(active);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (at + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next !== null) {
      e.preventDefault();
      onSelect(ids[next]!);
      const el = listRef.current?.querySelector<HTMLElement>(`[data-tabid="${ids[next]}"]`);
      el?.focus();
    }
  }, [tabs, active, onSelect]);

  // tablist children must be EXACTLY the tabs (axe aria-required-children,
  // caught by the audit) — so the close affordance lives INSIDE the tab as a
  // non-focusable click target, and the keyboard path is the Delete key
  return (
    <div className='tabsrow' role='tablist' aria-label={t('Characters')} ref={listRef}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type='button'
          role='tab'
          data-tabid={tab.id}
          aria-selected={tab.id === active}
          aria-controls='main-panel'
          tabIndex={tab.id === active ? 0 : -1}
          className={`ctab-btn ${tab.id === active ? 'on' : ''}`}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(e) => {
            if (e.key === 'Delete' && tab.id !== 'gallery') {
              e.preventDefault();
              onClose(tab.id);
              return;
            }
            onKeyDown(e);
          }}
        >
          {tab.label}
          {tab.id !== 'gallery' && (
            <span
              className='ctab-close'
              title={`${t('Close')} (${t('Delete key')})`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ---------------- log drawer + status bar ---------------- */

function useLog() {
  return useSyncExternalStore(
    (fn) => log.subscribe(fn),
    () => log.snapshot(),
  );
}

type Filter = 'all' | 'warn' | 'error';

const PASSES: Record<Filter, (s: Severity) => boolean> = {
  all: () => true,
  warn: (s) => s !== 'info',
  error: (s) => s === 'error',
};

export function LogDrawer({ open }: { open: boolean }) {
  const { lines } = useLog();
  const [filter, setFilter] = useState<Filter>('all');
  const [copied, setCopied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const visible = lines.filter((l) => PASSES[filter](l.severity));

  useEffect(() => {
    if (open) log.markSeen();
  }, [open, lines.length]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [visible.length, open]);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(visible.map((l) => l.line).join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {});
  }, [visible]);

  if (!open) return null;
  return (
    <section className='logdrawer' id='log-drawer' aria-label={t('Session log')}>
      <div className='loghead'>
        <span className='hud'>{t('Session log')}</span>
        <span className='logcount mono'>
          {visible.length}/{lines.length} {t('lines')}
        </span>
        <div className='logfilters' role='group' aria-label={t('Severity filter')}>
          {(['all', 'warn', 'error'] as const).map((f) => (
            <button
              key={f}
              type='button'
              className='logfilter'
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(f)}
            </button>
          ))}
        </div>
        <button type='button' className='btn logcopy' onClick={copy}>
          {copied ? t('Copied') : t('Copy')}
        </button>
      </div>
      <div className='logbody mono'>
        {visible.length === 0 && (
          <div className='logempty'>
            {t('Nothing yet — every line a core CLI writes lands here verbatim.')}
          </div>
        )}
        {visible.map((l) => (
          <div key={l.seq} className={`logline sev-${l.severity}`}>
            <span className='logjob'>{l.jobId}</span>
            <span className='logtext'>{l.line}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </section>
  );
}

export function StatusBar({ exam, counts, drawerOpen, onToggleDrawer }: {
  exam: {
    report: Record<string, unknown> | null;
    running: boolean;
    exitCode: number | null;
  };
  counts: { characters: number | null; bridge: string };
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}) {
  const { unseenErrors } = useLog();
  const rep = exam.report;
  const probeOk = (rep?.probe as { ok?: boolean } | undefined)?.ok;
  const sidecar = rep?.sidecar as
    | { ok: boolean; contractVersion?: number; adapters?: unknown[]; error?: string }
    | undefined;

  return (
    <footer className='statusbar'>
      {rep
        ? (
          <>
            <span>spritebook {String(rep.spritebook ?? '?')}</span>
            <span className={probeOk ? 'ok' : 'bad'}>
              {t('render')} {probeOk ? t('ok') : t('FAILED')}
            </span>
            {sidecar && (sidecar.ok
              ? (
                <span className='ok'>
                  {t('sidecar ok')} · {t('contract')} v{sidecar.contractVersion} ·{' '}
                  {sidecar.adapters?.length ?? 0} {t('adapters')}
                </span>
              )
              : (
                <span className='bad'>
                  {t('sidecar FAILED')} · {sidecar.error}
                </span>
              ))}
            {exam.exitCode !== 0 && exam.exitCode !== null && (
              <span className='bad'>exit {String(exam.exitCode)}</span>
            )}
          </>
        )
        : <span>{exam.running ? t('examining…') : t('health: not yet examined')}</span>}
      <span className='right'>
        <span>
          {counts.characters !== null ? `${counts.characters} ${t('characters')}` : ''}
        </span>
        <span>{t('bridge')}: {counts.bridge}</span>
        <button
          type='button'
          className={`loghandle ${unseenErrors > 0 ? 'haserr' : ''}`}
          aria-expanded={drawerOpen}
          aria-controls='log-drawer'
          onClick={onToggleDrawer}
        >
          {drawerOpen ? '▾' : '▴'} {t('log')}
          {unseenErrors > 0 && (
            <span className='logbadge'>
              {unseenErrors} {unseenErrors === 1 ? t('error') : t('errors')}
            </span>
          )}
        </button>
      </span>
    </footer>
  );
}
