/**
 * The window chrome: menu bar, character tabs, status bar, log drawer.
 * All read-only projections; the drawer renders relayed CLI lines VERBATIM.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Menu } from '@base-ui/react/menu';
import { t } from './i18n';
import { log, type Severity } from './log';
import type { StudioBridge } from './bridge';

/* ---------------- menu bar ---------------- */

function MenuEntry({ label, hint, onClick, disabled }: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Menu.Item className='menuitem' onClick={onClick} disabled={disabled}>
      <span>{label}</span>
      {hint && <span className='menuhint mono'>{hint}</span>}
    </Menu.Item>
  );
}

export function MenuBar(
  {
    theme,
    locale,
    gpu,
    canEdit,
    onThemeChange,
    onToggleLocale,
    onReload,
    onExam,
    onPalette,
    onModels,
    onUndo,
    onRedo,
  }: {
    theme: 'light' | 'dark';
    locale: string;
    gpu: string | null;
    /** a character tab is active — undo/redo have a manifest to act on */
    canEdit: boolean;
    onThemeChange: (theme: 'light' | 'dark') => void;
    onToggleLocale: () => void;
    onReload: () => void;
    onExam: () => void;
    onPalette: () => void;
    onModels: () => void;
    onUndo: () => void;
    onRedo: () => void;
  },
) {
  return (
    <header className='menubar'>
      <div className='logo'>
        <span className='wordmark'>SpriteBook</span>
      </div>
      <Menu.Root>
        <Menu.Trigger className='menubtn'>{t('File')}</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4}>
            <Menu.Popup className='menupop'>
              <MenuEntry label={t('Reload gallery')} onClick={onReload} />
              <MenuEntry label={t('Run health exam')} onClick={onExam} />
              <MenuEntry
                label={t('Manage models…')}
                hint='Ctrl+M'
                onClick={onModels}
              />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Menu.Root>
        <Menu.Trigger className='menubtn'>{t('Edit')}</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4}>
            <Menu.Popup className='menupop'>
              <MenuEntry
                label={t('Undo')}
                hint='Ctrl+Z'
                onClick={onUndo}
                disabled={!canEdit}
              />
              <MenuEntry
                label={t('Redo')}
                hint='Ctrl+Shift+Z'
                onClick={onRedo}
                disabled={!canEdit}
              />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <button type='button' className='menubtn' onClick={onModels}>
        {t('Manage models…')}
      </button>
      <div className='menur'>
        <button
          type='button'
          className='chip'
          onClick={onPalette}
          aria-label={t('Command palette')}
        >
          Ctrl+K
        </button>
        <button
          type='button'
          className='chip'
          onClick={onToggleLocale}
          aria-label={t('Switch language')}
        >
          {t('lang')}: {locale}
        </button>
        <label className='themecontrol'>
          {t('Theme')}
          <select
            value={theme}
            onChange={(e) => onThemeChange(e.target.value === 'light' ? 'light' : 'dark')}
          >
            <option value='light'>{t('Light')}</option>
            <option value='dark'>{t('Dark')}</option>
          </select>
        </label>
        <span className='chip gpuchip' title={gpu ?? undefined}>
          {gpu ? <b>{gpu}</b> : t('gpu: unexamined')}
        </span>
      </div>
    </header>
  );
}

/* ---------------- character tabs ---------------- */

export interface TabItem {
  id: string;
  label: string;
  detail?: string;
  closable?: boolean;
}

export function Tabs({ tabs, active, onSelect, onClose, onNew }: {
  tabs: TabItem[];
  active: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // roving arrows per the tabs pattern; Home/End for completeness
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const ids = tabs.map((x) => x.id);
    const at = ids.indexOf(active);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = (at + 1) % ids.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next !== null) {
      e.preventDefault();
      onSelect(ids[next]!);
      const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-tabid]') ?? [])]
        .find((tab) => tab.dataset.tabid === ids[next]);
      el?.focus();
    }
  }, [tabs, active, onSelect]);

  // tablist children must be EXACTLY the tabs (axe aria-required-children,
  // caught by the audit) — so the close affordance lives INSIDE the tab as a
  // non-focusable click target, and the keyboard path is the Delete key
  return (
    <aside className='tabsrow' aria-label={t('Character index')}>
      <div className='indexhead'>{t('Characters')}</div>
      <div
        className='tablist'
        role='tablist'
        aria-label={t('Characters')}
        aria-orientation='vertical'
        ref={listRef}
      >
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
              if (e.key === 'Delete' && tab.closable) {
                e.preventDefault();
                onClose(tab.id);
                // the focused tab is about to unmount - without this the
                // keyboard user falls to <body> and must re-tab from the top
                // (walkthrough finding). The app falls back to the gallery
                // tab, so focus follows the selection.
                requestAnimationFrame(() => {
                  listRef.current?.querySelector<HTMLElement>('[data-tabid="gallery"]')?.focus();
                });
                return;
              }
              onKeyDown(e);
            }}
          >
            <span className='ctab-label'>
              <span className='ctab-name'>{tab.label}</span>
              {tab.detail && <span className='ctab-detail'>{tab.detail}</span>}
            </span>
            {tab.closable && (
              <span
                className='ctab-close'
                title={`${t('Close')} (${t('Delete key')})`}
                aria-hidden='true'
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
      <button
        type='button'
        className='tabnew'
        aria-label={t('New character')}
        title={t('New character')}
        onClick={onNew}
      >
        <svg viewBox='0 0 20 20' aria-hidden='true'>
          <path d='M10 4v12M4 10h12' />
        </svg>
        {t('New character')}
      </button>
    </aside>
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

export function LogDrawer(
  { open, bridge, onRequestClose }: {
    open: boolean;
    bridge: StudioBridge;
    /** Escape inside the drawer closes it; the CALLER restores focus to the
     * handle, because only it knows where the handle lives. */
    onRequestClose?: () => void;
  },
) {
  const { lines } = useLog();
  const [filter, setFilter] = useState<Filter>('all');
  const [copied, setCopied] = useState(false);
  const [replayed, setReplayed] = useState<'no' | 'empty' | 'yes'>('no');

  const replay = useCallback(async () => {
    const prev = await bridge.prevSession(500);
    if (!prev || prev.length === 0) {
      setReplayed('empty');
      return;
    }
    for (const line of prev) {
      let jobId = 'replay';
      try {
        const e = JSON.parse(line);
        if (typeof e.jobId === 'string') jobId = `replay:${e.jobId}`;
      } catch { /* verbatim line, generic replay id */ }
      log.append(jobId, line);
    }
    setReplayed('yes');
    // the button disables itself on success and would drop keyboard focus to
    // <body> (walkthrough finding) - the log content the user just replayed
    // is the natural place to land
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('#log-drawer .logbody')?.focus();
    });
  }, [bridge]);
  const endRef = useRef<HTMLDivElement>(null);
  const visible = lines.filter((l) => PASSES[filter](l.severity));

  useEffect(() => {
    if (open) log.markSeen();
  }, [open, lines.length]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [visible.length, open]);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(visible.map((l) => l.line).join('\n')).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }, [visible]);

  if (!open) return null;
  return (
    <section
      className='logdrawer'
      id='log-drawer'
      aria-label={t('Session log')}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onRequestClose) {
          e.stopPropagation();
          onRequestClose();
        }
      }}
    >
      <div className='loghead'>
        <span className='hud'>{t('Session log')}</span>
        <span className='logcount mono'>
          {visible.length}/{lines.length} {t('lines')}
        </span>
        <div
          className='logfilters'
          role='group'
          aria-label={t('Severity filter')}
        >
          {(['all', 'warn', 'error'] as const).map((f) => (
            <button
              key={f}
              type='button'
              className='logfilter'
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? t('all') : f === 'warn' ? t('warn') : t('error')}
            </button>
          ))}
        </div>
        <button
          type='button'
          className='btn logcopy'
          onClick={replay}
          disabled={replayed !== 'no'}
        >
          {replayed === 'empty' ? t('no previous session') : t('Replay previous session')}
        </button>
        <button type='button' className='btn logcopy' onClick={copy}>
          {copied ? t('Copied') : t('Copy')}
        </button>
      </div>
      <div className='logbody mono' tabIndex={0} role='log' aria-label={t('Session log')}>
        {visible.length === 0 && (
          <div className='logempty'>
            {t(
              'Nothing yet — every line a core CLI writes lands here verbatim.',
            )}
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
    | {
      ok: boolean;
      contractVersion?: number;
      adapters?: unknown[];
      error?: string;
    }
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
        : (
          <span>
            {exam.running ? t('examining…') : t('health: not yet examined')}
          </span>
        )}
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
