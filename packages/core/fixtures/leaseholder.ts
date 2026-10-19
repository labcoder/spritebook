
/**
 * A real second process for the lease test: takes a claim, prints one line so
 * the parent knows it is held, sits, releases. Args: <dir> <gb> <jobId> <holdMs>
 */
import { acquireVramLease } from '../dist/vramlease.js';

const [dir, gb, jobId, holdMs] = process.argv.slice(2);
const lease = await acquireVramLease({
  dir,
  gb: Number(gb),
  jobId: jobId!,
  budgetGb: 24,
  pollMs: 30,
  heartbeatMs: 60,
  staleMs: 240,
  onWait: (r) => console.log(`WAIT ${r}`),
});
console.log(`HELD ${jobId}`);
await new Promise((r) => setTimeout(r, Number(holdMs)));
await lease.release();
console.log(`DONE ${jobId}`);
