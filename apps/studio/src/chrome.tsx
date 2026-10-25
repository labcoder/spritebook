/**
 * The window chrome: menu bar, character tabs, status bar, log drawer.
 * All read-only projections; the drawer renders relayed CLI lines VERBATIM.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Menu } from '@base-ui/react/menu';
import { type Locale, t } from './i18n';
import { log, type Severity } from './log';
import { openProjectWebsite, PROJECT_URL, type StudioBridge } from './bridge';
import { ProjectMenu } from './projectmenu';
import { Modal } from './modal';
import { SPRITEBOOK_VERSION } from '../../../packages/cli/version';

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
    canEdit,
    onThemeChange,
    onLocaleChange,
    onReload,
    onExam,
    onPalette,
    onModels,
    onUndo,
    onRedo,
    onDelete,
  }: {
    theme: 'light' | 'dark';
    locale: Locale;
    /** a character tab is active — undo/redo have a manifest to act on */
    canEdit: boolean;
    onThemeChange: (theme: 'light' | 'dark') => void;
    onLocaleChange: (locale: Locale) => void;
    onReload: () => void;
    onExam: () => void;
    onPalette: () => void;
    onModels: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onDelete: () => void;
  },
) {
  const [aboutOpen, setAboutOpen] = useState(false);
  return (
    <>
      <header className='menubar'>
        <div className='logo'>
          <span className='wordmark'>SpriteBook</span>
        </div>
        <Menu.Root>
          <Menu.Trigger className='menubtn'>{t('File')}</Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={4}>
              <Menu.Popup className='menupop'>
                <MenuEntry label={t('Shortcuts…')} hint='Ctrl+K' onClick={onPalette} />
                <MenuEntry label={t('Reload gallery')} onClick={onReload} />
                <MenuEntry label={t('Run health exam')} onClick={onExam} />
                <MenuEntry
                  label={t('Manage extensions…')}
                  hint='Ctrl+M'
                  onClick={onModels}
                />
                <MenuEntry label={t('About SpriteBook')} onClick={() => setAboutOpen(true)} />
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
                <MenuEntry label={t('Delete project…')} onClick={onDelete} disabled={!canEdit} />
                <Menu.SubmenuRoot>
                  <Menu.SubmenuTrigger className='menuitem submenu-trigger'>
                    {t('Language')}
                    <svg viewBox='0 0 20 20' aria-hidden='true'>
                      <path d='m8 5 5 5-5 5' />
                    </svg>
                  </Menu.SubmenuTrigger>
                  <Menu.Portal>
                    <Menu.Positioner sideOffset={4}>
                      <Menu.Popup className='menupop'>
                        <Menu.RadioGroup
                          value={locale}
                          onValueChange={onLocaleChange}
                          aria-label={t('Language')}
                        >
                          {([
                            'en',
                            'es',
                            ...(import.meta.env.DEV ? ['pseudo' as const] : []),
                          ] as Locale[]).map((value) => (
                            <Menu.RadioItem
                              key={value}
                              value={value}
                              closeOnClick
                              className='menuitem language-item'
                            >
                              <span>
                                {value === 'en' ? 'English' : value === 'es' ? 'Español' : 'Pseudo'}
                              </span>
                              <Menu.RadioItemIndicator>
                                <svg viewBox='0 0 20 20' aria-hidden='true'>
                                  <path d='m4 10 4 4 8-8' />
                                </svg>
                              </Menu.RadioItemIndicator>
                            </Menu.RadioItem>
                          ))}
                        </Menu.RadioGroup>
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.SubmenuRoot>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <button type='button' className='menubtn' onClick={onModels}>
          {t('Manage extensions…')}
        </button>
        <div className='menur'>
          <button
            type='button'
            className='icon-button'
            onClick={() => onThemeChange(theme === 'light' ? 'dark' : 'light')}
            aria-label={theme === 'dark' ? t('Switch to light theme') : t('Switch to dark theme')}
            title={theme === 'dark' ? t('Switch to light theme') : t('Switch to dark theme')}
          >
            <svg viewBox='0 0 20 20' aria-hidden='true'>
              {theme === 'dark'
                ? (
                  <>
                    <circle cx='10' cy='10' r='3.5' />
                    <path d='M10 1v2m0 14v2M1 10h2m14 0h2M3.6 3.6 5 5m10 10 1.4 1.4M3.6 16.4 5 15M15 5l1.4-1.4' />
                  </>
                )
                : <path d='M16.8 12.2A7.2 7.2 0 0 1 7.8 3.2a7.2 7.2 0 1 0 9 9Z' />}
            </svg>
          </button>
        </div>
      </header>
      <Modal
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        label={t('About SpriteBook')}
        className='pal about'
        initialFocus='button'
      >
        <img src='/app-icon.png' width='96' height='96' alt='' />
        <h2>SpriteBook Studio</h2>
        <p>{t('Version')} {SPRITEBOOK_VERSION}</p>
        <a
          href={PROJECT_URL}
          target='_blank'
          rel='noreferrer'
          onClick={(event) => {
            event.preventDefault();
            void openProjectWebsite().catch((error) => {
              log.append('about', String(error), Date.now(), 'stderr');
            });
          }}
        >
          github.com/labcoder/spritebook
        </a>
        <button type='button' className='btn' onClick={() => setAboutOpen(false)}>
          {t('Close')}
        </button>
      </Modal>
    </>
  );
}

/* ---------------- character tabs ---------------- */

export interface TabItem {
  id: string;
  label: string;
  detail?: string;
  closable?: boolean;
  deletable?: boolean;
}

export function Tabs({ tabs, active, onSelect, onClose, onNew, onDelete }: {
  tabs: TabItem[];
  active: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
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
          <ProjectMenu
            key={tab.id}
            onDelete={tab.deletable ? () => onDelete(tab.id) : undefined}
          >
            <button
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
                  <svg viewBox='0 0 20 20' aria-hidden='true'>
                    <path d='m5 5 10 10M5 15 15 5' />
                  </svg>
                </span>
              )}
            </button>
          </ProjectMenu>
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

export function StatusBar({ exam, counts, gpu, drawerOpen, onToggleDrawer }: {
  exam: {
    report: Record<string, unknown> | null;
    running: boolean;
    exitCode: number | null;
  };
  counts: { characters: number | null; bridge: string };
  gpu: string | null;
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
        <span className='gpu-status' title={gpu ?? undefined}>{gpu ?? t('gpu: unexamined')}</span>
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
          <svg viewBox='0 0 20 20' aria-hidden='true'>
            <path d={drawerOpen ? 'm5 8 5 5 5-5' : 'm5 12 5-5 5 5'} />
          </svg>
          {t('log')}
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
