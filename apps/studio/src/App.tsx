/**
 * The walking skeleton (P4-T1 start): one window wearing the ratified tokens —
 * menu bar, read-only character gallery over existing workspaces, status bar
 * with the doctor + sidecar exam. Read-only by construction: the only core
 * verb this window can run is `doctor`.
 */
import { useCallback, useEffect, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { makeBridge } from './bridge';
import { type CharacterCard, toCard } from './manifest';

const bridge = makeBridge();

interface ExamState {
  running: boolean;
  report: Record<string, unknown> | null;
  exitCode: number | null;
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark');
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('sb-theme', next);
      } catch {
        // storage unavailable: theme is per-session then
      }
      return next;
    });
  }, []);
  return [theme, toggle];
}

function Thumb({ dir }: { dir: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    bridge.readThumb(dir).then((s) => {
      if (!live) return;
      if (s) setSrc(s);
      else setMissing(true);
    }, () => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [dir]);
  return (
    <div className='thumb' aria-hidden='true'>
      {src
        ? <img src={src} alt='' />
        : <span className='nothumb'>{missing ? 'no bake yet' : '…'}</span>}
    </div>
  );
}

function Card({ c }: { c: CharacterCard }) {
  return (
    <div className='card'>
      <Thumb dir={c.dir} />
      <div className='cardbody'>
        <div className='cardname'>{c.displayName}</div>
        <div className='cardid'>
          {c.id}
          {c.heightM !== undefined ? ` · ${c.heightM.toFixed(2)} m` : ''}
          {c.pickedResultId ? ` · pick ${c.pickedResultId}` : ''}
        </div>
        {c.problem
          ? (
            <div className='tags'>
              <span className='tag rig-warn'>{c.problem}</span>
            </div>
          )
          : (
            <div className='tags'>
              {c.stylePresetId && <span className='tag style'>{c.stylePresetId}</span>}
              {c.rig && (
                <span className={`tag ${c.rig.accepted ? 'rig-ok' : 'rig-warn'}`}>
                  rig {c.rig.track}
                  {c.rig.jointCount !== undefined ? ` · ${c.rig.jointCount}j` : ''}
                  {c.rig.accepted ? ' · accepted' : ' · unaccepted'}
                </span>
              )}
              {c.lastBakeId && <span className='tag baked'>baked {c.lastBakeId}</span>}
            </div>
          )}
      </div>
    </div>
  );
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [root, setRoot] = useState(() => {
    try {
      return localStorage.getItem('sb-projects-root') ?? 'spikes/trellis2/out/p3-exit';
    } catch {
      return 'spikes/trellis2/out/p3-exit';
    }
  });
  const [cards, setCards] = useState<CharacterCard[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exam, setExam] = useState<ExamState>({ running: false, report: null, exitCode: null });

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const ws = await bridge.listWorkspaces(root);
      setCards(ws.map((w) => toCard(w.dir, w.manifest)));
      try {
        localStorage.setItem('sb-projects-root', root);
      } catch {
        // per-session only
      }
    } catch (err) {
      setCards(null);
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

  const rep = exam.report;
  const adapter = rep?.adapter as { description?: string } | undefined;
  const sidecar = rep?.sidecar as
    | { ok: boolean; contractVersion?: number; adapters?: unknown[]; error?: string }
    | undefined;

  return (
    <div className='app'>
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
          <Menu.Trigger className='menubtn'>File</Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={4}>
              <Menu.Popup className='menupop'>
                <Menu.Item className='menuitem' onClick={load}>Reload gallery</Menu.Item>
                <Menu.Item className='menuitem' onClick={runExam}>
                  Run health exam
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <div className='menur'>
          <button type='button' className='chip' onClick={toggleTheme}>
            theme: {theme}
          </button>
          <span className='chip'>
            {adapter?.description ? <b>{adapter.description}</b> : 'gpu: unexamined'}
          </span>
        </div>
      </header>

      <div className='toolbar'>
        <label htmlFor='root'>Projects root</label>
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
        <button type='button' className='btn' onClick={load}>Load</button>
        <button type='button' className='btn primary' onClick={runExam} disabled={exam.running}>
          {exam.running ? 'Examining…' : 'Run health exam'}
        </button>
      </div>

      <main className='gallery' aria-label='Characters'>
        {loadError && (
          <div className='empty'>
            <p>Could not read that root.</p>
            <p className='mono'>{loadError}</p>
          </div>
        )}
        {cards && cards.length === 0 && (
          <div className='empty'>
            <p>No characters under this root.</p>
            <p className='mono'>a character is any directory holding a character.json</p>
          </div>
        )}
        {cards?.map((c) => <Card key={c.dir} c={c} />)}
      </main>

      <footer className='statusbar'>
        {rep
          ? (
            <>
              <span>spritebook {String(rep.spritebook ?? '?')}</span>
              <span className={(rep.probe as { ok?: boolean })?.ok ? 'ok' : 'bad'}>
                render {(rep.probe as { ok?: boolean })?.ok ? 'ok' : 'FAILED'}
              </span>
              {sidecar && (sidecar.ok
                ? (
                  <span className='ok'>
                    sidecar ok · contract v{sidecar.contractVersion} ·{' '}
                    {sidecar.adapters?.length ?? 0} adapters
                  </span>
                )
                : <span className='bad'>sidecar FAILED · {sidecar.error}</span>)}
              {exam.exitCode !== 0 && <span className='bad'>exit {String(exam.exitCode)}</span>}
            </>
          )
          : <span>{exam.running ? 'examining…' : 'health: not yet examined'}</span>}
        <span className='right'>
          <span>{cards ? `${cards.length} characters` : ''}</span>
          <span>bridge: {bridge.name}</span>
          <span>studio 0.1.0</span>
        </span>
      </footer>
    </div>
  );
}
