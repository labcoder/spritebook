// P0-T3: mock `spritebook` core CLI. Emits the NDJSON event vocabulary from
// docs/architecture/architecture.md (queued|started|progress|artifact|done)
// so both shell candidates can prove child-process spawn + stream ergonomics.
//
//   deno run spikes/shell/mock-cli/main.ts --frames=50 --interval=10

const arg = (name: string, def: number) => {
  const a = Deno.args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : def;
};
const frames = arg('frames', 50);
const intervalMs = arg('interval', 10);

const jobId = crypto.randomUUID();
const emit = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, jobId, ts: new Date().toISOString(), ...data }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

emit('queued');
emit('started', { verb: 'bake', frames });
for (let f = 1; f <= frames; f++) {
  emit('progress', { frame: f, pct: Math.round((f / frames) * 100) });
  if (intervalMs > 0) await sleep(intervalMs);
}
emit('artifact', { path: 'mock://atlas-page-0.png', kind: 'atlas' });
emit('done', { ok: true, frames });
