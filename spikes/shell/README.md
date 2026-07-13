# P0-T3 — shell spike (resolves D-005)

**Throwaway by contract** (see `docs/internal/roadmap/p0.md`). The comparison evidence in
[REPORT.md](./REPORT.md) is the deliverable: **deno desktop vs Tauri v2**, each booting the same
Vite + React 19 + Base UI probe app with our fonts, file-drop, and a mock core CLI child process
streaming NDJSON.

## Layout

- `app/` — the shared probe app (menu, dialog, number-field scrubbing, fonts, drop zone, NDJSON log
  well, self-test that writes evidence via the active shell's bridge)
- `mock-cli/` — mock `spritebook` core CLI emitting the architecture's NDJSON event vocabulary
- `tauri/` — Tauri v2 shell (custom `spawn_mock_job` / `save_selftest` commands)
- `denoshell/` — official `deno desktop` shell (Deno 2.9+, experimental); `test-window.ts` is the
  minimal repro for the BrowserWindow constructor hang (see REPORT)
- `out/` — self-test evidence files (gitignored)

## Run

```sh
# shared app, standalone in a browser
deno task --cwd spikes/shell/app dev          # http://localhost:5173

# Tauri (spawns the vite dev server itself)
cd spikes/shell/tauri && deno run -A npm:@tauri-apps/cli@2.11.4 dev

# deno desktop (vite dev server must already be running; launch from spikes/shell)
cd spikes/shell && deno desktop --hmr --allow-run --allow-read --allow-write --allow-env denoshell/main.ts

# packaged builds
cd spikes/shell/tauri && deno run -A npm:@tauri-apps/cli@2.11.4 build
cd spikes/shell && deno desktop --allow-run --allow-read --allow-write --allow-env -o build/DenoshellSpike denoshell/main.ts
```

Self-test evidence lands in `spikes/shell/out/selftest-<shell>.json` automatically when a shell
boots the app.
