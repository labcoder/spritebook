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
 *   rssMb        the Deno processes' working set. A JS/handle leak climbs here.
 *   vramMb       nvidia-smi memory.used across the card. A GPU-resource leak
 *                climbs here while RSS stays flat — the exact shape the
 *                viewport-disposal work was about, and invisible to any
 *                JS-side measurement.
 *   handles      Windows handle count. A file-descriptor or texture-view leak
 *                shows here first and is the earliest warning of the other two.
 *
 * Output is NDJSON, one sample per line, so a run that is killed halfway is
 * still readable. `--report <file.ndjson>` summarises an existing run:
 * first/last/peak per series, and a least-squares slope per hour, which is the
 * number "flat memory" actually means.
 *
 * Run alongside the thing under test:
 *   deno run --allow-all tools/proofs/soak.ts --out soak.ndjson --every 15
 *   deno run --allow-all tools/proofs/soak.ts --report soak.ndjson
 */
const arg = (name: string, fallback = ''): string => {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 && Deno.args[i + 1] !== undefined ? Deno.args[i + 1]! : fallback;
};

interface Sample {
  t: number;
  /** seconds since the sampler started */
  elapsedS: number;
  rssMb: number;
  handles: number;
  procs: number;
  vramMb: number | null;
}

async function run(cmd: string[]): Promise<string | null> {
  try {
    const out = await new Deno.Command(cmd[0]!, {
      args: cmd.slice(1),
      stdout: 'piped',
      stderr: 'null',
    }).output();
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
): Promise<{ rssMb: number; handles: number; procs: number }> {
  const isWindows = Deno.build.os === 'windows';
  if (isWindows) {
    const ps = await run([
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue; ` +
      `if ($p) { '{0} {1} {2}' -f (($p | Measure-Object WorkingSet64 -Sum).Sum), ` +
      `(($p | Measure-Object HandleCount -Sum).Sum), @($p).Count } else { '0 0 0' }`,
    ]);
    const [ws, handles, procs] = (ps ?? '0 0 0').trim().split(/\s+/).map(Number);
    return {
      rssMb: Math.round((ws ?? 0) / 1024 / 1024),
      handles: handles ?? 0,
      procs: procs ?? 0,
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
  return { rssMb: Math.round(rssKb / 1024), handles: 0, procs };
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
function slopePerHour(samples: Sample[], pick: (s: Sample) => number | null): number | null {
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
        ((last.elapsedS - first.elapsedS) / Math.max(1, samples.length - 1)).toFixed(1)
      }s`,
  );
  const series: [string, (s: Sample) => number | null, string][] = [
    ['rss', (s) => s.rssMb, 'MB'],
    ['handles', (s) => s.handles, ''],
    ['vram', (s) => s.vramMb, 'MB'],
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

if (arg('report')) {
  const text = await Deno.readTextFile(arg('report'));
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
} else {
  const out = arg('out', 'soak.ndjson');
  const everyS = Number(arg('every', '15'));
  const name = arg('proc', 'deno');
  const untilS = Number(arg('for', '0')); // 0 = until killed
  const started = performance.now();
  console.log(
    `soak: sampling '${name}' every ${everyS}s -> ${out}${
      untilS > 0 ? ` for ${untilS}s` : ' (until killed)'
    }`,
  );
  const file = await Deno.open(out, { create: true, write: true, append: true });
  const enc = new TextEncoder();
  const samples: Sample[] = [];
  for (;;) {
    const elapsedS = (performance.now() - started) / 1000;
    const [proc, vramMb] = await Promise.all([sampleProcesses(name), sampleVramMb()]);
    const s: Sample = { t: Math.round(Date.now() / 1000), elapsedS, ...proc, vramMb };
    samples.push(s);
    await file.write(enc.encode(JSON.stringify(s) + '\n'));
    if (untilS > 0 && elapsedS >= untilS) break;
    await new Promise((r) => setTimeout(r, everyS * 1000));
  }
  file.close();
  for (const line of report(samples)) console.log(line);
}
