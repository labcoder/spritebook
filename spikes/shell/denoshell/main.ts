// P0-T3 deno desktop shell (official `deno desktop` subcommand, Deno 2.9+, experimental).
//
//   dev:  deno task --cwd spikes/shell/app dev     (vite on 5173, separate terminal)
//         deno desktop --allow-run --allow-read --allow-write --allow-env spikes/shell/denoshell/main.ts
//
// Bindings appear on the page as `bindings.denoshellSpawn` / `bindings.denoshellSave`;
// Deno pushes NDJSON lines into the page via executeJs -> window.__denoshell_online.

console.log('creating BrowserWindow…');
const win = new Deno.BrowserWindow({
  title: 'SpriteBook shell spike (deno desktop)',
  width: 1100,
  height: 820,
});
console.log('BrowserWindow created');

// NOTE (evidence): import.meta.dirname is unusable under `deno desktop` — the
// script runs from an embedded compile context and dirname points at a fake
// Temp\deno-compile-laufey_webview.exe path. Anchor to the launch cwd instead
// (this shell must be launched from spikes/shell).
const root = Deno.cwd();
const outDir = `${root}/out`;

win.bind('denoshellSpawn', async (...args) => {
  const frames = Number(args[0] ?? 50); // bind args arrive as BrowserWindowValue
  const child = new Deno.Command('deno', {
    args: ['run', `${root}/mock-cli/main.ts`, `--frames=${frames}`, '--interval=10'],
    stdout: 'piped',
    stderr: 'null',
  }).spawn();

  // hand-rolled line split to avoid a new dependency in a spike
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line) {
        await win.executeJs(
          `window.__denoshell_online && window.__denoshell_online(${JSON.stringify(line)})`,
        );
      }
    }
  }
  const status = await child.status;
  return status.code;
});

win.bind('denoshellSave', async (...args) => {
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeTextFile(`${outDir}/selftest-denoshell.json`, String(args[0] ?? ''));
  return true;
});

const breadcrumb = (name: string, data: Record<string, unknown> = {}) => {
  try {
    Deno.writeTextFileSync(
      `${outDir}/denoshell-${name}.json`,
      JSON.stringify({ ts: new Date().toISOString(), ...data }),
    );
  } catch { /* best effort */ }
};

win.addEventListener('close', () => breadcrumb('closed'));
globalThis.addEventListener('unhandledrejection', (e) => {
  breadcrumb('unhandledrejection', { reason: String((e as PromiseRejectionEvent).reason) });
});
globalThis.addEventListener('error', (e) => {
  breadcrumb('error', { message: String((e as ErrorEvent).message) });
});

const url = Deno.env.get('SHELL_SPIKE_URL') ?? 'http://localhost:5173';
await Deno.mkdir(outDir, { recursive: true });
await Deno.writeTextFile(
  `${outDir}/denoshell-started.json`,
  JSON.stringify({ ts: new Date().toISOString(), url }),
);
win.navigate(url);
console.log(`denoshell up: ${url}`);
breadcrumb('navigated', { url });

// headless-harness probes: capture what the webview actually sees (shell
// detection, bindings visibility, page title) at 3s and 15s
const probeAt = (delayMs: number) =>
  setTimeout(async () => {
    try {
      const probe = await win.executeJs(
        `JSON.stringify({
          title: document.title,
          hasBindings: typeof bindings !== 'undefined',
          boundFns: typeof bindings !== 'undefined' ? Object.keys(bindings) : [],
          badge: document.querySelector('.badge')?.textContent ?? null,
          selftest: document.getElementById('selftest')?.textContent?.slice(0, 400) ?? null,
        })`,
      );
      breadcrumb(`probe-${delayMs}`, { probe: JSON.parse(String(probe)) });
    } catch (e) {
      breadcrumb(`probe-${delayMs}`, { error: String(e) });
    }
  }, delayMs);
probeAt(3000);
probeAt(15000);
