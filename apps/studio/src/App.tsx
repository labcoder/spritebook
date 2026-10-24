/** Studio projects core manifests; mutations and jobs stay behind the CLI bridge. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react';
import { makeBridge, type RawWorkspace } from './bridge';
import { type CharacterCard, toCard } from './manifest';
import { activateLocale, t } from './i18n';
import { prefs } from './prefs';
import { Gallery } from './gallery';
import { Editor } from './editor';
import { LogDrawer, MenuBar, StatusBar, Tabs } from './chrome';
import { Palette, type PaletteAction } from './palette';
import { ManageExtensions } from './extensions';
import { GenerateNew } from './gen';
import { journalArgs } from './args';
import { useLandFocus } from './focus';
import { DeleteProject } from './delete-project';

const bridge = makeBridge();

interface ExamState {
  running: boolean;
  report: Record<string, unknown> | null;
  exitCode: number | null;
}

interface Workspace {
  raw: RawWorkspace;
  card: CharacterCard;
}

/** The current directory - where a cold open lands before any choice, and
 * the recovery target when a remembered root has vanished (F1: temp dirs,
 * ejected drives, renamed folders are expectable states, not dead ends). */
const DEFAULT_ROOT = '.';

export default function App() {
  // useLingui subscribes this tree to locale changes — t() re-renders live
  useLingui();
  const [theme, setThemeState] = useState(prefs.theme());
  const [locale, setLocaleState] = useState(prefs.locale());
  const [root, setRoot] = useState(() => prefs.projectsRoot(DEFAULT_ROOT));
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exam, setExam] = useState<ExamState>({
    running: false,
    report: null,
    exitCode: null,
  });
  const [openDirs, setOpenDirs] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('gallery');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CharacterCard | null>(null);
  // bumped when Manage extensions closes, so the + tab's backend cards re-read
  // the catalog in the very flow that installs
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  useLandFocus(activeTab === '__new__', '#gname');
  useLandFocus(activeTab === 'gallery', '.library-head button');
  useLandFocus(
    activeTab !== 'gallery' && activeTab !== '__new__',
    '[data-tabid][aria-selected="true"]',
  );

  // side effects OUTSIDE the updaters: i18n.activate() sets state in
  // I18nProvider, and an updater runs during render — React refuses a
  // cross-component setState from there (it wedged the palette's close)
  const toggleTheme = useCallback(() => {
    setThemeState((cur) => (cur === 'dark' ? 'light' : 'dark'));
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    prefs.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    activateLocale(locale);
    prefs.setLocale(locale);
  }, [locale]);

  const currentRoot = useRef(root);
  currentRoot.current = root;
  const loadEpoch = useRef(0);
  const activeOwner = useRef(activeTab);
  activeOwner.current = activeTab;

  const load = useCallback(async (): Promise<Workspace[] | null> => {
    if (currentRoot.current !== root) return null;
    const epoch = ++loadEpoch.current;
    setLoadError(null);
    try {
      const ws = await bridge.listWorkspaces(root);
      if (currentRoot.current !== root || epoch !== loadEpoch.current) {
        return null;
      }
      const next = ws.map((raw) => ({
        raw,
        card: toCard(raw.dir, raw.manifest),
      }));
      setWorkspaces(next);
      prefs.setProjectsRoot(root);
      return next;
    } catch (err) {
      if (currentRoot.current !== root || epoch !== loadEpoch.current) {
        return null;
      }
      setWorkspaces(null);
      setLoadError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [root]);

  const runExam = useCallback(async () => {
    setExam({ running: true, report: null, exitCode: null });
    const r = await bridge.runDoctor({ sidecar: true });
    setExam({ running: false, report: r.report, exitCode: r.exitCode });
  }, []);

  useEffect(() => {
    load();
  }, [load, activeTab]);

  const openCharacter = useCallback((dir: string) => {
    setOpenDirs((cur) => (cur.includes(dir) ? cur : [...cur, dir]));
    setActiveTab(dir);
  }, []);

  const closeTab = useCallback((dir: string) => {
    if (dir === '__new__') setNewOpen(false);
    else setOpenDirs((cur) => cur.filter((d) => d !== dir));
    setActiveTab((cur) => (cur === dir ? 'gallery' : cur));
  }, []);

  const openNew = useCallback(() => {
    setNewOpen(true);
    setActiveTab('__new__');
  }, []);

  // gen exited 0: the workspace exists now. Resolve it BY CHARACTER ID from
  // the re-read list - the shell's dir notation (absolute, backslashes) never
  // matches a GUI-composed relative path, and matching strings instead of ids
  // is how the first field test got a tab that said "no longer under the
  // loaded root" about a character it had just created.
  const onCreated = useCallback(async (characterId: string) => {
    setNewOpen(false);
    const list = await load();
    if (!list) return;
    const created = list?.find((w) => w.card.id === characterId);
    if (!created) {
      setActiveTab('gallery');
      return;
    }
    setOpenDirs((
      cur,
    ) => (cur.includes(created.raw.dir) ? cur : [...cur, created.raw.dir]));
    setActiveTab(created.raw.dir);
    // the Generate form the user was focused in unmounts on this navigation;
    // land keyboard focus on the new character's tab so the journey continues
    // from something real (walkthrough finding). Iterate rather than build a
    // selector: the dir is a Windows path and backslashes are CSS escapes.
    requestAnimationFrame(() => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-tabid]')) {
        if (el.dataset.tabid === created.raw.dir) {
          el.focus();
          break;
        }
      }
    });
  }, [load]);

  // undo/redo act on the ACTIVE character's manifest through the core verbs
  // (invariant 7: journaled patches; the GUI is just a caller). The drawer
  // carries the verbatim result; a changed manifest re-projects on reload.
  const runJournal = useCallback(async (verb: 'undo' | 'redo') => {
    if (activeTab === 'gallery' || activeTab === '__new__') return;
    const r = await bridge.runCli([...journalArgs(activeTab, verb), '--json']);
    if (activeOwner.current !== activeTab) return;
    if (r.exitCode === 0) await load();
    if (!drawerOpen && r.exitCode !== 0) setDrawerOpen(true);
  }, [activeTab, load, drawerOpen]);

  // global shortcuts: Ctrl/⌘K palette, Ctrl/⌘M models, Ctrl/⌘Z(+Shift) journal.
  // Z is left to the browser inside text fields — native input undo wins there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (deleteTarget) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const inField = e.target instanceof HTMLElement &&
        ['input', 'textarea'].includes(e.target.tagName.toLowerCase());
      if (k === 'k') {
        setPaletteOpen((v) => !v);
        e.preventDefault();
      } else if (k === 'm') {
        setModelsOpen(true);
        e.preventDefault();
      } else if (k === 'z' && !inField) {
        runJournal(e.shiftKey ? 'redo' : 'undo');
        e.preventDefault();
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [runJournal, deleteTarget]);

  const byDir = useMemo(
    () => new Map((workspaces ?? []).map((w) => [w.raw.dir, w])),
    [workspaces],
  );
  // computed every render ON PURPOSE: t() output must never be cached across
  // an i18n.activate() (the tabs lagged one locale behind under useMemo)
  const tabs = [
    { id: 'gallery', label: t('Gallery') },
    ...(workspaces ?? []).map(({ card }) => ({
      id: card.dir,
      label: card.displayName,
      detail: card.id !== card.displayName ? card.id : card.stylePresetId,
      closable: openDirs.includes(card.dir),
      deletable: !card.problem,
    })),
    ...openDirs.filter((dir) => !byDir.has(dir)).map((dir) => ({
      id: dir,
      label: dir.split(/[\\/]/).pop() ?? dir,
      closable: true,
    })),
    ...(newOpen ? [{ id: '__new__', label: t('New character'), closable: true }] : []),
  ];

  const activeWs = activeTab === 'gallery' ? undefined : byDir.get(activeTab);
  const requestDelete = (dir: string) => {
    const target = byDir.get(dir)?.card;
    if (target && !target.problem) setDeleteTarget(target);
  };
  const adapter = exam.report?.adapter as { description?: string } | undefined;

  // the palette lists ONLY actions that exist elsewhere in the chrome
  const paletteActions: PaletteAction[] = [
    { id: 'reload', title: t('Reload gallery'), enabled: true, run: load },
    { id: 'exam', title: t('Run health exam'), enabled: true, run: runExam },
    {
      id: 'models',
      title: t('Manage extensions…'),
      hint: 'Ctrl+M',
      enabled: true,
      run: () => setModelsOpen(true),
    },
    { id: 'theme', title: t('Switch theme'), enabled: true, run: toggleTheme },
    {
      id: 'drawer',
      title: t('Toggle session log'),
      enabled: true,
      run: () => setDrawerOpen((v) => !v),
    },
    {
      id: 'undo',
      title: t('Undo'),
      hint: 'Ctrl+Z',
      enabled: activeWs !== undefined,
      run: () => runJournal('undo'),
    },
    {
      id: 'redo',
      title: t('Redo'),
      hint: 'Ctrl+Shift+Z',
      enabled: activeWs !== undefined,
      run: () => runJournal('redo'),
    },
    {
      id: 'new',
      title: t('New character'),
      enabled: !newOpen,
      run: openNew,
    },
    {
      id: 'delete',
      title: t('Delete project…'),
      enabled: activeWs !== undefined && !activeWs.card.problem,
      run: () => requestDelete(activeTab),
    },
    {
      id: 'gallery',
      title: t('Go to gallery'),
      enabled: activeTab !== 'gallery',
      run: () => setActiveTab('gallery'),
    },
    ...openDirs.map((dir) => ({
      id: `open-${dir}`,
      title: `${t('Go to')} ${byDir.get(dir)?.card.displayName ?? dir}`,
      enabled: true,
      run: () => setActiveTab(dir),
    })),
    ...(workspaces ?? []).filter((w) => !openDirs.includes(w.raw.dir)).map((
      w,
    ) => ({
      id: `openc-${w.raw.dir}`,
      title: `${t('Open')} ${w.card.displayName}`,
      enabled: true,
      run: () => openCharacter(w.raw.dir),
    })),
  ];

  return (
    <div className='app'>
      <MenuBar
        theme={theme}
        locale={locale}
        canEdit={activeWs !== undefined && !activeWs.card.problem}
        onThemeChange={setThemeState}
        onLocaleChange={setLocaleState}
        onReload={load}
        onExam={runExam}
        onPalette={() => setPaletteOpen(true)}
        onModels={() => setModelsOpen(true)}
        onUndo={() => runJournal('undo')}
        onRedo={() => runJournal('redo')}
        onDelete={() => requestDelete(activeTab)}
      />
      {deleteTarget && (
        <DeleteProject
          key={deleteTarget.dir}
          bridge={bridge}
          project={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            ++loadEpoch.current;
            setWorkspaces((current) =>
              current?.filter((ws) => ws.raw.dir !== deleteTarget.dir) ?? null
            );
            closeTab(deleteTarget.dir);
            setDeleteTarget(null);
            void load();
          }}
        />
      )}
      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />
      <ManageExtensions
        bridge={bridge}
        open={modelsOpen}
        onClose={() => {
          setModelsOpen(false);
          // an install may have happened in there - the + tab's backend
          // cards re-read the catalog, so "installed" is never stale in the
          // very flow that installs (the UX pass hit exactly this)
          setCatalogEpoch((e) => e + 1);
        }}
      />
      <div className='workbench'>
        {activeTab !== 'gallery' && activeTab !== '__new__' && (
          <Tabs
            tabs={tabs}
            active={activeTab}
            onSelect={(id) => {
              if (id === 'gallery' || id === '__new__') setActiveTab(id);
              else openCharacter(id);
            }}
            onClose={closeTab}
            onNew={openNew}
            onDelete={requestDelete}
          />
        )}
        <div className='workarea'>
          {activeTab === 'gallery' && (
            <div className='library-chrome'>
              <header className='library-head'>
                <div>
                  <h1>{t('Characters')}</h1>
                  <p>{t('Open a character or start with a reference image.')}</p>
                </div>
                <button type='button' className='btn primary' onClick={openNew}>
                  {t('New character')}
                </button>
              </header>
              <div className='toolbar'>
                {
                  /* NOT id='root': index.html mounts React on <div id="root">, and
              the duplicate id made querySelector('#root') answer with the
              mount div - found when a driver tried to type into it */
                }
                <label htmlFor='projectsroot'>{t('Projects root')}</label>
                <input
                  id='projectsroot'
                  className='rootinput'
                  value={root}
                  onChange={(e) => setRoot(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') load();
                  }}
                  spellCheck={false}
                />
                <button type='button' className='btn' onClick={load}>
                  {t('Load')}
                </button>
                {
                  /* aria-busy, not disabled: disabling the focused button drops
              keyboard focus to <body> for the whole exam (walkthrough) */
                }
                <button
                  type='button'
                  className='btn'
                  onClick={() => {
                    if (!exam.running) runExam();
                  }}
                  aria-busy={exam.running}
                >
                  {exam.running ? t('Examining…') : t('Run health exam')}
                </button>
              </div>
            </div>
          )}

          <main
            id='main-panel'
            role={activeTab === 'gallery' || activeTab === '__new__' ? undefined : 'tabpanel'}
            aria-label={activeTab === 'gallery'
              ? t('Gallery')
              : activeTab === '__new__'
              ? t('New character')
              : activeWs?.card.displayName}
            className='mainpanel'
          >
            {activeTab === 'gallery'
              ? (
                <Gallery
                  bridge={bridge}
                  cards={workspaces?.map((w) => w.card) ?? null}
                  loadError={loadError}
                  onOpen={openCharacter}
                  onDelete={requestDelete}
                  onUseDefault={() => setRoot(DEFAULT_ROOT)}
                />
              )
              : activeTab === '__new__'
              ? (
                <GenerateNew
                  key={root}
                  bridge={bridge}
                  projectsRoot={root}
                  onCreated={onCreated}
                  onBack={() => closeTab('__new__')}
                  onOpenModels={() => setModelsOpen(true)}
                  catalogEpoch={catalogEpoch}
                  vramGb={typeof exam.report?.vramGb === 'number' ? exam.report.vramGb : null}
                />
              )
              : activeWs
              ? (
                <Editor
                  key={activeWs.card.dir}
                  onOpenModels={() => setModelsOpen(true)}
                  catalogEpoch={catalogEpoch}
                  bridge={bridge}
                  card={activeWs.card}
                  manifest={activeWs.raw.manifest}
                  onChanged={load}
                />
              )
              : (
                <div className='empty'>
                  <p>{t('This character is no longer under the loaded root.')}</p>
                </div>
              )}
          </main>
        </div>
      </div>

      <LogDrawer
        open={drawerOpen}
        bridge={bridge}
        onRequestClose={() => {
          setDrawerOpen(false);
          // focus returns to the handle that owns the disclosure
          requestAnimationFrame(() => {
            document.querySelector<HTMLElement>('.loghandle')?.focus();
          });
        }}
      />
      <StatusBar
        gpu={adapter?.description ?? null}
        exam={exam}
        counts={{ characters: workspaces?.length ?? null, bridge: bridge.name }}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
      />
    </div>
  );
}
