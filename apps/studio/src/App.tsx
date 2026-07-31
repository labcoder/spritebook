/**
 * SpriteBook Studio — the T1 chrome over the walking skeleton. Read-only by
 * construction: the only core verb this window can run is `doctor`; every
 * panel is a projection of character manifests.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react';
import { makeBridge, type RawWorkspace } from './bridge';
import { type CharacterCard, toCard } from './manifest';
import { activateLocale, t } from './i18n';
import { prefs } from './prefs';
import { Gallery } from './gallery';
import { Editor } from './editor';
import { LogDrawer, MenuBar, StatusBar, Tabs } from './chrome';

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
  const [exam, setExam] = useState<ExamState>({ running: false, report: null, exitCode: null });
  const [openDirs, setOpenDirs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string>('gallery');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const toggleTheme = useCallback(() => {
    setThemeState((cur) => {
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      prefs.setTheme(next);
      return next;
    });
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((cur) => {
      const next = cur === 'en' ? 'pseudo' : 'en';
      activateLocale(next);
      prefs.setLocale(next);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const ws = await bridge.listWorkspaces(root);
      setWorkspaces(ws.map((raw) => ({ raw, card: toCard(raw.dir, raw.manifest) })));
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

  const byDir = useMemo(
    () => new Map((workspaces ?? []).map((w) => [w.raw.dir, w])),
    [workspaces],
  );
  const tabs = useMemo(() => [
    { id: 'gallery', label: t('Gallery') },
    ...openDirs.map((dir) => ({
      id: dir,
      label: byDir.get(dir)?.card.displayName ?? dir.split(/[\\/]/).pop() ?? dir,
    })),
  ], [openDirs, byDir, locale]);

  const activeWs = activeTab === 'gallery' ? undefined : byDir.get(activeTab);
  const adapter = exam.report?.adapter as { description?: string } | undefined;

  return (
    <div className='app'>
      <MenuBar
        theme={theme}
        locale={locale}
        gpu={adapter?.description ?? null}
        onToggleTheme={toggleTheme}
        onToggleLocale={toggleLocale}
        onReload={load}
        onExam={runExam}
      />
      <Tabs tabs={tabs} active={activeTab} onSelect={setActiveTab} onClose={closeTab} />

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
          <button type='button' className='btn' onClick={load}>{t('Load')}</button>
          <button type='button' className='btn primary' onClick={runExam} disabled={exam.running}>
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
          ? <Editor bridge={bridge} card={activeWs.card} manifest={activeWs.raw.manifest} />
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
