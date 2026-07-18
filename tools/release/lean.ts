/**
 * Prepare a LEAN release tree in-place (run in a throwaway checkout/worktree,
 * never the working repo). `deno compile` embeds the physical node_modules —
 * not the reachable graph — so a full-tree build ships the GUI spike's
 * toolchain and the importer's native deps for nothing (compile-spike, P2-T4),
 * and sharp cannot load from the compile VFS anyway (D-025). Steps:
 *   1. delete spikes/ (its package.json pollutes npm resolution with every
 *      platform's vite/tauri/rolldown variants)
 *   2. delete packages/importer/ and drop it from the workspace array
 *      (`spritebook import` is run-from-source until D-025 is revisited)
 *   3. swap deno.lock for the COMMITTED tools/release/lean.lock — the lean
 *      tree's own full resolution, transitives included. `deno install`
 *      materializes whatever lock it sees (a lean tree with the full lock
 *      still installed 152 MB of spike platform binaries), and a lock-FREE
 *      install would let transitives float (direct pins are exact, but e.g.
 *      fast-png -> iobuffer/pako are ranges) so the shipped binary would not
 *      be the tested tree. Regenerate lean.lock whenever deps change: run
 *      steps 1-2 in a scratch worktree, `rm deno.lock && deno install`, copy
 *      the result here.
 * After this script: `deno install --frozen` then `deno compile --frozen`.
 *
 *   deno run --allow-read --allow-write tools/release/lean.ts
 */
const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function removeVerified(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true }).catch(() => {});
  // a silently-failed deletion would ship the fat build this script exists to
  // prevent, with every downstream smoke still green — verify, loudly
  const still = await Deno.stat(path).then(() => true, () => false);
  if (still) throw new Error(`lean.ts: failed to remove ${path}`);
}

await removeVerified(`${root}/spikes`);
await removeVerified(`${root}/packages/importer`);

const denoJsonPath = `${root}/deno.json`;
const config = JSON.parse(await Deno.readTextFile(denoJsonPath));
config.workspace = (config.workspace as string[]).filter((w) => w !== './packages/importer');
await Deno.writeTextFile(denoJsonPath, JSON.stringify(config, null, 2) + '\n');

await Deno.copyFile(`${root}/tools/release/lean.lock`, `${root}/deno.lock`);

console.log('lean release tree ready: spikes/ + importer removed; lean.lock installed');
