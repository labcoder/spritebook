import { runProcess } from '../testing/process.ts';
import { promises as fs } from 'node:fs';
/**
 * The soak sampler (P4-T3): does a long unattended run end with flat memory?
 *
 * Deliberately an OUTSIDE observer rather than instrumentation inside the
 * bake. A process that samples itself reports nothing at all once it wedges,
 * which is the failure a soak exists to catch — so this polls the OS from a
 * separate process and keeps writing whether or not the subject is healthy.
 *
 * Three series, because the three ways this can go wrong are unrelated:
 *
 *   rssMb        the Node processes' working set. A JS/handle leak climbs here.
 *   vramMb       nvidia-smi memory.used across the card. A GPU-resource leak
 *                climbs here while RSS stays flat — the exact shape the
 *                viewport-disposal work was about, and invisible to any
 *                JS-side measurement.
 *   handles      Windows handle count. A file-descriptor or texture-view leak
 *                shows here first and is the earliest warning of the other two.
 *   freeMb       free space on the drive under test. NOT a leak in the same
 *                sense — an unbounded cache or a temp directory that is never
 *                swept is an ACCUMULATION failure, invisible to every series
 *                above, and it does not show as a trend at all: it shows as a
 *                cliff when the volume fills. A soak that runs a bake sixteen
 *                times and does not watch the disk is not watching the thing
 *                most likely to end the run.
 *
 * Output is NDJSON, one sample per line, so a run that is killed halfway is
 * still readable. `--report <file.ndjson>` summarises an existing run:
 * first/last/peak per series, and a least-squares slope per hour, which is the
 * number "flat memory" actually means.
 *
 * Run alongside the thing under test:
 *   node tools/run.mjs tools/proofs/soak.ts --out soak.ndjson --every 15
 *   node tools/run.mjs tools/proofs/soak.ts --report soak.ndjson
 */
const arg = (name: string, fallback = ''): string => {
  const i = process.argv.slice(2).indexOf(`--${name}`);
  return i >= 0 && process.argv.slice(2)[i + 1] !== undefined
    ? process.argv.slice(2)[i + 1]!
    : fallback;
};

interface Sample {
  t: number;
  /** seconds since the sampler started */
  elapsedS: number;
  rssMb: number;
  handles: number;
  procs: number;
  vramMb: number | null;
  /** free space on the sampled drive, MB; null where it could not be read */
  freeMb: number | null;
}

async function run(cmd: string[]): Promise<string | null> {
  try {
    const out = await runProcess(cmd[0]!, cmd.slice(1));
    if (!out.success) return null;
    return new TextDecoder().decode(out.stdout);
  } catch {
    return null;
  }
}

/**
 * One PowerShell call per sample on Windows (`tasklist` cannot report handle
 * counts reliably), `ps` elsewhere. Every failure path degrades to zeros
 * rather than throwing: a soak that dies because its instrument hiccupped has
 * measured nothing, which is worse than a gap in the series.
 */
async function sampleProcesses(
  name: string,
  drive: string,
): Promise<
  { rssMb: number; handles: number; procs: number; freeMb: number | null }
> {
  const isWindows = (process.platform === 'win32' ? 'windows' : process.platform) === 'windows';
  if (isWindows) {
    // free space rides the SAME PowerShell call as the process table — one
    // subprocess per sample, not two, because the sampler must stay cheap
    // enough that it is not itself part of what is being measured
    const ps = await run([
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue; ` +
      `$d = (Get-PSDrive '${drive}' -ErrorAction SilentlyContinue).Free; ` +
      `if ($p) { '{0} {1} {2} {3}' -f (($p | Measure-Object WorkingSet64 -Sum).Sum), ` +
      `(($p | Measure-Object HandleCount -Sum).Sum), @($p).Count, $d } ` +
      `else { '0 0 0 {0}' -f $d }`,
    ]);
    const [ws, handles, procs, free] = (ps ?? '0 0 0 0').trim().split(/\s+/)
      .map(Number);
    return {
      rssMb: Math.round((ws ?? 0) / 1024 / 1024),
      handles: handles ?? 0,
      procs: procs ?? 0,
      freeMb: Number.isFinite(free) && free > 0 ? Math.round(free / 1024 / 1024) : null,
    };
  }
  const out = await run(['ps', '-o', 'rss=,comm=']);
  let rssKb = 0;
  let procs = 0;
  for (const line of (out ?? '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m && m[2]!.includes(name)) {
      rssKb += Number(m[1]);
      procs++;
    }
  }
  const df = await run(['df', '-Pk', '.']);
  const line = (df ?? '').split(/\r?\n/)[1]?.trim().split(/\s+/);
  const freeKb = line ? Number(line[3]) : NaN;
  return {
    rssMb: Math.round(rssKb / 1024),
    handles: 0,
    procs,
    freeMb: Number.isFinite(freeKb) ? Math.round(freeKb / 1024) : null,
  };
}

async function sampleVramMb(): Promise<number | null> {
  const out = await run([
    'nvidia-smi',
    '--query-gpu=memory.used',
    '--format=csv,noheader,nounits',
  ]);
  const first = (out ?? '').split('\n')[0]?.trim();
  const n = Number(first);
  return Number.isFinite(n) ? n : null;
}

/** Least-squares slope of y over elapsed hours — "flat" is |slope| near zero. */
function slopePerHour(
  samples: Sample[],
  pick: (s: Sample) => number | null,
): number | null {
  const pts = samples
    .map((s) => [s.elapsedS / 3600, pick(s)] as const)
    .filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

function report(samples: Sample[]): string[] {
  if (samples.length === 0) return ['no samples'];
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const lines: string[] = [];
  const hours = (last.elapsedS - first.elapsedS) / 3600;
  lines.push(
    `soak: ${samples.length} samples over ${(last.elapsedS - first.elapsedS).toFixed(0)}s ` +
      `(${hours.toFixed(2)} h), every ~${
        ((last.elapsedS - first.elapsedS) / Math.max(1, samples.length - 1))
          .toFixed(1)
      }s`,
  );
  const series: [string, (s: Sample) => number | null, string][] = [
    ['rss', (s) => s.rssMb, 'MB'],
    ['handles', (s) => s.handles, ''],
    ['vram', (s) => s.vramMb, 'MB'],
    // free space FALLS as the run writes, so a NEGATIVE slope here is expected
    // and the number to read is how much is left, not the trend
    ['freeMb', (s) => s.freeMb, 'MB'],
  ];
  for (const [name, pick, unit] of series) {
    const vals = samples.map(pick).filter((v): v is number => v !== null);
    if (vals.length === 0) {
      lines.push(`  ${name.padEnd(8)} (not available on this machine)`);
      continue;
    }
    const slope = slopePerHour(samples, pick);
    lines.push(
      `  ${name.padEnd(8)} first ${String(pick(first) ?? '-').padStart(7)}${unit} · ` +
        `last ${String(pick(last) ?? '-').padStart(7)}${unit} · ` +
        `peak ${String(Math.max(...vals)).padStart(7)}${unit} · ` +
        `slope ${slope === null ? '-' : slope.toFixed(1)}${unit}/h`,
    );
  }
  // the honest headline: what a reader should conclude
  const rssSlope = slopePerHour(samples, (s) => s.rssMb);
  if (rssSlope !== null) {
    lines.push(
      `  verdict: RSS trend ${rssSlope >= 0 ? '+' : ''}${rssSlope.toFixed(1)} MB/h over ` +
        `${hours.toFixed(2)} h. A trend measured over less than an hour extrapolates badly; ` +
        `state the window, not the extrapolation.`,
    );
  }
  return lines;
}

interface Phase {
  name: string;
  fromS: number;
  toS: number;
}

/**
 * Recover the subject's phase boundaries from a `roster100.ts` log.
 *
 * The sampler is deliberately blind to what it watches — it polls the OS and
 * knows nothing about bakes — so attributing a trend to a PHASE means aligning
 * two clocks. The log prints `(M min in)` against its own start; the NDJSON
 * counts from the sampler's. `offsetS` is the second measured against the
 * first, and everything here is that one addition.
 *
 * The build phase is not printed and has to be inferred: pivot 1 starts at
 * `M1` and the cold batch ran for `coldDur` before it, so whatever came before
 * `M1 - coldDur` was the build. Inferring it matters because the build is a
 * `npm run check` — a different program with a different memory profile — and a
 * slope fitted across that step describes the step, not a leak.
 */
function parsePhases(log: string, offsetS: number): Phase[] {
  const at = (min: number) => min * 60 + offsetS;
  const pivots = [
    ...log.matchAll(/^## pivot (\d+)\/\d+ .*?\((-?[\d.]+) min in\)/gm),
  ]
    .map((m) => ({ n: Number(m[1]), startMin: Number(m[2]) }));
  const coldDurS = Number(/^cold batch ([\d.]+)s/m.exec(log)?.[1] ?? NaN);
  const phases: Phase[] = [];
  if (pivots.length > 0 && Number.isFinite(coldDurS)) {
    const coldStartMin = pivots[0]!.startMin - coldDurS / 60;
    if (coldStartMin > 0) {
      phases.push({ name: 'build', fromS: offsetS, toS: at(coldStartMin) });
    }
    phases.push({
      name: 'cold bake',
      fromS: at(coldStartMin),
      toS: at(pivots[0]!.startMin),
    });
  }
  for (let i = 0; i < pivots.length; i++) {
    const next = pivots[i + 1];
    phases.push({
      name: `pivot ${pivots[i]!.n}`,
      fromS: at(pivots[i]!.startMin),
      // the last phase runs to the end of the series; the caller clamps
      toS: next ? at(next.startMin) : Number.MAX_SAFE_INTEGER,
    });
  }
  return phases;
}

/**
 * The per-phase table, and the number that actually answers "is it leaking".
 *
 * A least-squares slope over a whole soak is a WEAK test: it is dominated by
 * where in a cycle the run happened to stop, so the same healthy run reads
 * +58 MB/h or -25 MB/h depending on the last few samples. The leak-sensitive
 * measure is the FLOOR — the minimum a phase settles back to once its
 * allocations are returned. A process that leaks cannot return to its previous
 * floor; a process that merely works hard can, however high its peak went.
 *
 * So the headline here is the drift of per-cycle floors, in MB per cycle, and
 * the peaks are reported beside them only to show the working set the floors
 * are being recovered from.
 */
function phaseReport(all: Sample[], phases: Phase[]): string[] {
  const lines: string[] = [];
  lines.push(
    '  phase        window (h)      samples   RSS floor/peak    handles floor/peak',
  );
  const floors: {
    name: string;
    rss: number;
    handles: number;
    samples: number;
  }[] = [];
  for (const p of phases) {
    const inPhase = all.filter((s) => s.elapsedS >= p.fromS && s.elapsedS < p.toS);
    if (inPhase.length === 0) continue;
    const rss = inPhase.map((s) => s.rssMb);
    const hnd = inPhase.map((s) => s.handles);
    const lo = Math.min(...rss), hi = Math.max(...rss);
    const hLo = Math.min(...hnd), hHi = Math.max(...hnd);
    lines.push(
      `  ${p.name.padEnd(12)} ${(p.fromS / 3600).toFixed(2)}-${
        (Math.min(p.toS, all.at(-1)!.elapsedS) / 3600).toFixed(2)
      }`.padEnd(30) +
        `${String(inPhase.length).padStart(6)}   ` +
        `${String(lo).padStart(6)}/${String(hi).padEnd(6)}   ` +
        `${String(hLo).padStart(6)}/${String(hHi).padEnd(6)}`,
    );
    if (p.name.startsWith('pivot')) {
      floors.push({
        name: p.name,
        rss: lo,
        handles: hLo,
        samples: inPhase.length,
      });
    }
  }
  // A PARTIAL phase has no floor. The minimum of thirteen samples taken while a
  // cycle is still working is not the value that cycle settles to — it is just
  // the smallest number seen so far, and it reads high. Including one costs
  // nothing but the verdict: on the first run of this report a cycle that was
  // 6% in turned a flat series into "+166 MB/cycle, DRIFTING".
  //
  // So a cycle contributes a floor only once it has run at least half the
  // median cycle's samples, and the ones dropped are NAMED rather than quietly
  // skipped — a bisect that silently ignores cycles is how a real leak hides.
  const lengths = floors.map((f) => f.samples).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const partial = floors.filter((f) => f.samples < median / 2);
  const settled = floors.filter((f) => f.samples >= median / 2);
  if (partial.length > 0) {
    lines.push('');
    lines.push(
      `  excluded from the drift: ${
        partial.map((f) => `${f.name} (${f.samples} samples)`).join(', ')
      } - still running, so its minimum is not a floor`,
    );
  }
  floors.length = 0;
  floors.push(...settled);
  if (floors.length >= 3) {
    // regress the floors against cycle INDEX, not time: cycles are the unit a
    // leak would repeat over, and they are near enough equal length that the
    // two agree — but the index is what a reader can act on ("per cycle").
    const drift = (pick: (f: typeof floors[number]) => number) => {
      const n = floors.length;
      const mx = (n - 1) / 2;
      const my = floors.reduce((a, f) => a + pick(f), 0) / n;
      let num = 0, den = 0;
      floors.forEach((f, i) => {
        num += (i - mx) * (pick(f) - my);
        den += (i - mx) ** 2;
      });
      return den === 0 ? 0 : num / den;
    };
    const rssDrift = drift((f) => f.rss);
    const hndDrift = drift((f) => f.handles);
    lines.push('');
    lines.push(
      `  floor drift over ${floors.length} cycles: ` +
        `RSS ${rssDrift >= 0 ? '+' : ''}${rssDrift.toFixed(1)} MB/cycle · ` +
        `handles ${hndDrift >= 0 ? '+' : ''}${hndDrift.toFixed(1)}/cycle`,
    );
    // A leak has a SIGN. Only a RISING floor is one; a falling floor is the
    // allocator returning more than it did last cycle, which is the opposite
    // finding and must not be reported with the same word. The first draft of
    // this check compared magnitudes and called -79 MB/cycle "the leak
    // signature", which would have condemned a healthy run.
    const rising = rssDrift > 25 || hndDrift > 5;
    const flat = Math.abs(rssDrift) <= 25 && Math.abs(hndDrift) <= 5;
    lines.push(
      `  ${
        rising
          ? 'RISING: the floor a cycle settles to is climbing - this is the leak signature.'
          : flat
          ? 'FLAT: each cycle returns to the same floor, so the peaks are working set, not leak.'
          : 'FALLING: each cycle settles LOWER than the last. Not a leak; check the window ' +
            'does not include process exit, which reads as a floor of near zero.'
      }`,
    );
  }
  return lines;
}

if (arg('report')) {
  const text = await fs.readFile(arg('report'), 'utf8');
  const all = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Sample);
  // `--from` / `--to` (elapsed seconds) window the analysis. That is not
  // cherry-picking as long as the window is stated, and it is necessary when
  // the subject changes phase: a light build becoming a GPU bake is a STEP,
  // and a slope fitted across a step is a number about the phase boundary
  // rather than about a leak. Report both windows and say which is which.
  const from = Number(arg('from', '0'));
  const to = Number(arg('to', String(Number.MAX_SAFE_INTEGER)));
  const samples = all.filter((s) => s.elapsedS >= from && s.elapsedS <= to);
  if (from > 0 || to < Number.MAX_SAFE_INTEGER) {
    console.log(
      `window ${from}s..${to === Number.MAX_SAFE_INTEGER ? 'end' : `${to}s`}: ` +
        `${samples.length} of ${all.length} samples`,
    );
  }
  for (const line of report(samples)) console.log(line);

  // `--phases <roster.log>` attributes the trend to a phase. The offset
  // between the two clocks defaults to the log file's creation time measured
  // against the first sample, which is right whenever the sampler was started
  // first (the documented order); `--phase-offset` overrides it for a log
  // copied off the machine, where birth time means nothing.
  const phaseLog = arg('phases');
  if (phaseLog) {
    const log = await fs.readFile(phaseLog, 'utf8');
    let offsetS = Number(arg('phase-offset', 'NaN'));
    if (!Number.isFinite(offsetS)) {
      const birth = (await fs.stat(phaseLog)).birthtime;
      offsetS = birth ? birth.getTime() / 1000 - all[0]!.t + all[0]!.elapsedS : 0;
    }
    const phases = parsePhases(log, offsetS);
    console.log('');
    console.log(
      `phases from ${phaseLog} (subject started ${offsetS.toFixed(0)}s into the sampler):`,
    );
    // the WINDOWED samples, not `all` — the last phase has no end marker and
    // runs to the end of the series, so an unwindowed table swallows the tail
    // after the subject exited and reports its floor as a near-zero RSS. The
    // offset above still comes from `all`, because it is about when the
    // SAMPLER started, which `--from` does not move.
    for (const line of phaseReport(samples, phases)) console.log(line);
  }
} else {
  const out = arg('out', 'soak.ndjson');
  const everyS = Number(arg('every', '15'));
  const name = arg('proc', 'node');
  const drive = arg('drive', 'C');
  const untilS = Number(arg('for', '0')); // 0 = until killed
  const started = performance.now();
  console.log(
    `soak: sampling '${name}' every ${everyS}s -> ${out}${
      untilS > 0 ? ` for ${untilS}s` : ' (until killed)'
    }`,
  );
  await using file = await fs.open(out, 'a');
  const enc = new TextEncoder();
  const samples: Sample[] = [];
  for (;;) {
    const elapsedS = (performance.now() - started) / 1000;
    const [proc, vramMb] = await Promise.all([
      sampleProcesses(name, drive),
      sampleVramMb(),
    ]);
    const s: Sample = {
      t: Math.round(Date.now() / 1000),
      elapsedS,
      ...proc,
      vramMb,
    };
    samples.push(s);
    await file.write(enc.encode(JSON.stringify(s) + '\n'));
    if (untilS > 0 && elapsedS >= untilS) break;
    await new Promise((r) => setTimeout(r, everyS * 1000));
  }
  for (const line of report(samples)) console.log(line);
}
