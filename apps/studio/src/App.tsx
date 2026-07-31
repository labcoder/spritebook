/**
 * SpriteBook Studio — the T1 chrome over the walking skeleton. Read-only by
 * construction: the only core verb this window can run is `doctor`; every
 * panel is a projection of character manifests.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react';
import { makeBridge, type RawWorkspace } from './bridge';
import { type CharacterCard, toCard } from './manifest';
import { activateLocale, cycleLocale, type Locale, t } from './i18n';
import { prefs } from './prefs';
import { Gallery } from './gallery';
import { Editor } from './editor';
import { LogDrawer, MenuBar, StatusBar, Tabs } from './chrome';
import { Palette, type PaletteAction } from './palette';
import { ManageModels } from './models';

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

export default function App() {
  // useLingui subscribes this tree to locale changes — t() re-renders live
  useLingui();
  const [theme, setThemeState] = useState(prefs.theme());
  const [locale, setLocaleState] = useState(prefs.locale());
  const [root, setRoot] = useState(() => prefs.projectsRoot('spikes/trellis2/out/p3-exit'));
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exam, setExam] = useState<ExamState>({
    running: false,
    report: null,
    exitCode: null,
  });
  const [openDirs, setOpenDirs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string>('gallery');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);

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

  const toggleLocale = useCallback(() => {
    setLocaleState((cur: Locale) => cycleLocale(cur));
  }, []);
  useEffect(() => {
    activateLocale(locale);
    prefs.setLocale(locale);
  }, [locale]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const ws = await bridge.listWorkspaces(root);
      setWorkspaces(
        ws.map((raw) => ({ raw, card: toCard(raw.dir, raw.manifest) })),
      );
      prefs.setProjectsRoot(root);
    } catch (err) {
      setWorkspaces(null);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [root]);

  const runExam = useCallback(async () => {
    setExam({ running: true, report: null, exitCode: null });
    const r = await bridge.runDoctor({ sidecar: true });
    setExam({ running: false, report: r.report, exitCode: r.exitCode });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCharacter = useCallback((dir: string) => {
    setOpenDirs((cur) => (cur.includes(dir) ? cur : [...cur, dir]));
    setActiveTab(dir);
  }, []);

  const closeTab = useCallback((dir: string) => {
    setOpenDirs((cur) => cur.filter((d) => d !== dir));
    setActiveTab((cur) => (cur === dir ? 'gallery' : cur));
  }, []);

  // undo/redo act on the ACTIVE character's manifest through the core verbs
  // (invariant 7: journaled patches; the GUI is just a caller). The drawer
  // carries the verbatim result; a changed manifest re-projects on reload.
  const runJournal = useCallback(async (verb: 'undo' | 'redo') => {
    if (activeTab === 'gallery') return;
    const manifest = `${activeTab}/character.json`;
    const r = await bridge.runCli([verb, '--manifest', manifest, '--json']);
    if (r.exitCode === 0) await load();
    if (!drawerOpen && r.exitCode !== 0) setDrawerOpen(true);
  }, [activeTab, load, drawerOpen]);

  // global shortcuts: Ctrl/⌘K palette, Ctrl/⌘M models, Ctrl/⌘Z(+Shift) journal.
  // Z is left to the browser inside text fields — native input undo wins there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runJournal]);

  const byDir = useMemo(
    () => new Map((workspaces ?? []).map((w) => [w.raw.dir, w])),
    [workspaces],
  );
  // computed every render ON PURPOSE: t() output must never be cached across
  // an i18n.activate() (the tabs lagged one locale behind under useMemo)
  const tabs = [
    { id: 'gallery', label: t('Gallery') },
    ...openDirs.map((dir) => ({
      id: dir,
      label: byDir.get(dir)?.card.displayName ?? dir.split(/[\\/]/).pop() ?? dir,
    })),
  ];

  const activeWs = activeTab === 'gallery' ? undefined : byDir.get(activeTab);
  const adapter = exam.report?.adapter as { description?: string } | undefined;

  // the palette lists ONLY actions that exist elsewhere in the chrome
  const paletteActions: PaletteAction[] = [
    { id: 'reload', title: t('Reload gallery'), enabled: true, run: load },
    { id: 'exam', title: t('Run health exam'), enabled: true, run: runExam },
    {
      id: 'models',
      title: t('Manage models…'),
      hint: 'Ctrl+M',
      enabled: true,
      run: () => setModelsOpen(true),
    },
    { id: 'theme', title: t('Switch theme'), enabled: true, run: toggleTheme },
    {
      id: 'locale',
      title: t('Switch language'),
      enabled: true,
      run: toggleLocale,
    },
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
      enabled: activeTab !== 'gallery',
      run: () => runJournal('undo'),
    },
    {
      id: 'redo',
      title: t('Redo'),
      hint: 'Ctrl+Shift+Z',
      enabled: activeTab !== 'gallery',
      run: () => runJournal('redo'),
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
        gpu={adapter?.description ?? null}
        canEdit={activeTab !== 'gallery'}
        onToggleTheme={toggleTheme}
        onToggleLocale={toggleLocale}
        onReload={load}
        onExam={runExam}
        onPalette={() => setPaletteOpen(true)}
        onModels={() => setModelsOpen(true)}
        onUndo={() => runJournal('undo')}
        onRedo={() => runJournal('redo')}
      />
      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />
      <ManageModels
        bridge={bridge}
        open={modelsOpen}
        onClose={() => setModelsOpen(false)}
      />
      <Tabs
        tabs={tabs}
        active={activeTab}
        onSelect={setActiveTab}
        onClose={closeTab}
      />

      {activeTab === 'gallery' && (
        <div className='toolbar'>
          <label htmlFor='root'>{t('Projects root')}</label>
          <input
            id='root'
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
          <button
            type='button'
            className='btn primary'
            onClick={runExam}
            disabled={exam.running}
          >
            {exam.running ? t('Examining…') : t('Run health exam')}
          </button>
        </div>
      )}

      <main
        id='main-panel'
        role='tabpanel'
        aria-label={activeTab === 'gallery' ? t('Gallery') : activeWs?.card.displayName}
        className='mainpanel'
      >
        {activeTab === 'gallery'
          ? (
            <Gallery
              bridge={bridge}
              cards={workspaces?.map((w) => w.card) ?? null}
              loadError={loadError}
              onOpen={openCharacter}
            />
          )
          : activeWs
          ? (
            <Editor
              bridge={bridge}
              card={activeWs.card}
              manifest={activeWs.raw.manifest}
            />
          )
          : (
            <div className='empty'>
              <p>{t('This character is no longer under the loaded root.')}</p>
            </div>
          )}
      </main>

      <LogDrawer open={drawerOpen} />
      <StatusBar
        exam={exam}
        counts={{ characters: workspaces?.length ?? null, bridge: bridge.name }}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
      />
    </div>
  );
}
