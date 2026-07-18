/**
 * Prepare a LEAN release tree in-place (run in a throwaway checkout/worktree,
 * never the working repo). `deno compile` embeds the physical node_modules
 * wholesale — not the reachable graph — so a full-tree build ships the GUI
 * spike's toolchain and the importer's native deps (cesium/three/sharp) for
 * nothing (compile-spike finding, P2-T4). The CLI graph (cli -> pack ->
 * style/render -> schema/core + export) never imports the importer, and sharp
 * cannot load from the compile VFS anyway (D-025), so release binaries build
 * from a tree without them:
 *   1. delete spikes/ (throwaway by contract; its package.json pollutes npm
 *      resolution with every platform's vite/tauri/rolldown variants)
 *   2. delete packages/importer/ and drop it from the workspace array
 *      (`spritebook import` is run-from-source until D-025 is revisited)
 * After this script: `deno install --frozen` then `deno compile` per target.
 *
 *   deno run --allow-read --allow-write tools/release/lean.ts
 */
const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

await Deno.remove(`${root}/spikes`, { recursive: true }).catch(() => {});
await Deno.remove(`${root}/packages/importer`, { recursive: true }).catch(() => {});

const denoJsonPath = `${root}/deno.json`;
const config = JSON.parse(await Deno.readTextFile(denoJsonPath));
config.workspace = (config.workspace as string[]).filter((w) => w !== './packages/importer');
await Deno.writeTextFile(denoJsonPath, JSON.stringify(config, null, 2) + '\n');

console.log('lean release tree ready: spikes/ + packages/importer/ removed');
