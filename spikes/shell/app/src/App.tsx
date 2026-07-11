// P0-T3 probe app: the four webview-sensitive things from the roadmap —
// a menu, a dialog, a number field with drag-scrubbing, our fonts — plus the
// two architecture probes: file-drop and child-process NDJSON streaming.
import * as React from 'react';
import { Menu } from '@base-ui/react/menu';
import { Dialog } from '@base-ui/react/dialog';
import { NumberField } from '@base-ui/react/number-field';
import { detectBridge } from './bridge';

const bridge = detectBridge();

interface DroppedFile {
  label: string;
  mechanism: 'native' | 'html5';
}

interface SelfTest {
  shell: string;
  userAgent: string;
  jobEvents: number;
  jobMs: number;
  eventsPerSec: number;
  fonts: Record<string, boolean>;
  ts: string;
}

export default function App() {
  const [cellSize, setCellSize] = React.useState<number | null>(128);
  const [menuChoice, setMenuChoice] = React.useState('(none)');
  const [drops, setDrops] = React.useState<DroppedFile[]>([]);
  const [log, setLog] = React.useState<string[]>([]);
  const [jobStatus, setJobStatus] = React.useState('idle');
  const [selfTest, setSelfTest] = React.useState<SelfTest | null>(null);
  const logRef = React.useRef<HTMLPreElement>(null);

  const runJob = React.useCallback(async (frames: number, quiet = false) => {
    const lines: string[] = [];
    setLog([]);
    setJobStatus('running…');
    const t0 = performance.now();
    const { exitCode } = await bridge.spawnJob(frames, (line) => {
      lines.push(line);
      if (!quiet) setLog([...lines]);
    });
    const ms = performance.now() - t0;
    setLog([...lines]);
    setJobStatus(`exit ${exitCode} · ${lines.length} events in ${ms.toFixed(0)} ms`);
    return { events: lines.length, ms };
  }, []);

  // self-test on mount: fonts + a quiet streaming job, evidence saved via the shell
  React.useEffect(() => {
    (async () => {
      await document.fonts.ready;
      // load every face we ship, not just the ones already used by visible text
      await Promise.all([
        document.fonts.load('400 16px "Chakra Petch"'),
        document.fonts.load('600 16px "Chakra Petch"'),
        document.fonts.load('400 16px "IBM Plex Sans"'),
        document.fonts.load('400 16px "IBM Plex Mono"'),
      ]);
      const { events, ms } = await runJob(50, true);
      const st: SelfTest = {
        shell: bridge.name,
        userAgent: navigator.userAgent,
        jobEvents: events,
        jobMs: Math.round(ms),
        eventsPerSec: Math.round(events / (ms / 1000)),
        fonts: {
          chakraPetch: document.fonts.check('400 16px "Chakra Petch"') &&
            document.fonts.check('600 16px "Chakra Petch"'),
          ibmPlexSans: document.fonts.check('400 16px "IBM Plex Sans"'),
          ibmPlexMono: document.fonts.check('400 16px "IBM Plex Mono"'),
        },
        ts: new Date().toISOString(),
      };
      setSelfTest(st);
      await bridge.saveSelfTest(JSON.stringify(st, null, 2));
    })();
  }, [runJob]);

  React.useEffect(() => {
    bridge.onNativeFileDrop?.((paths) =>
      setDrops((d) => [...d, ...paths.map((p) => ({ label: p, mechanism: 'native' as const }))])
    );
  }, []);

  React.useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  const onHtml5Drop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].map((f) => ({
      label: `${f.name} (no path — HTML5)`,
      mechanism: 'html5' as const,
    }));
    setDrops((d) => [...d, ...files]);
  };

  return (
    <div className='shell'>
      <header>
        <h1>SpriteBook shell spike</h1>
        <span className='badge' data-shell={bridge.name}>{bridge.name}</span>
      </header>

      <div className='cards'>
        <section className='card'>
          <h2>Menu</h2>
          <Menu.Root>
            <Menu.Trigger className='btn'>File</Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner className='positioner' sideOffset={4}>
                <Menu.Popup className='popup'>
                  {['New character', 'Import model…', 'Bake sheet', 'Export…'].map((item) => (
                    <Menu.Item key={item} className='item' onClick={() => setMenuChoice(item)}>
                      {item}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          <p className='hint'>picked: {menuChoice}</p>
        </section>

        <section className='card'>
          <h2>Dialog</h2>
          <Dialog.Root>
            <Dialog.Trigger className='btn'>Rename character…</Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Backdrop className='backdrop' />
              <Dialog.Popup className='dialog'>
                <Dialog.Title>Rename character</Dialog.Title>
                <Dialog.Description>
                  Display name only — the characterId never changes (D-011).
                </Dialog.Description>
                <input defaultValue='brave-knight' autoFocus />
                <div className='row'>
                  <Dialog.Close className='btn'>Cancel</Dialog.Close>
                  <Dialog.Close className='btn primary'>Rename</Dialog.Close>
                </div>
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        </section>

        <section className='card'>
          <h2>Number field + scrub</h2>
          <NumberField.Root value={cellSize} onValueChange={setCellSize} min={16} max={512}>
            <NumberField.ScrubArea className='scrub'>
              <label>Cell size (px) — drag me</label>
              <NumberField.ScrubAreaCursor className='scrub-cursor'>↔</NumberField.ScrubAreaCursor>
            </NumberField.ScrubArea>
            <NumberField.Group className='nf-group'>
              <NumberField.Decrement className='btn sq'>−</NumberField.Decrement>
              <NumberField.Input className='nf-input' />
              <NumberField.Increment className='btn sq'>+</NumberField.Increment>
            </NumberField.Group>
          </NumberField.Root>
        </section>

        <section
          className='card drop'
          onDragOver={(e) => e.preventDefault()}
          onDrop={onHtml5Drop}
        >
          <h2>File drop</h2>
          <p className='hint'>drop files here</p>
          <ul>
            {drops.map((d, i) => (
              <li key={i}>
                <code>{d.label}</code> <em>[{d.mechanism}]</em>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className='card wide'>
        <h2>Core CLI child process (NDJSON)</h2>
        <div className='row'>
          <button type='button' className='btn primary' onClick={() => runJob(50)}>
            Run mock bake
          </button>
          <span className='hint'>{jobStatus}</span>
        </div>
        <pre className='logwell' ref={logRef}>{log.join('\n')}</pre>
      </section>

      <section className='card wide'>
        <h2>Self-test</h2>
        <pre id='selftest'>{selfTest ? JSON.stringify(selfTest, null, 2) : 'running…'}</pre>
      </section>
    </div>
  );
}
