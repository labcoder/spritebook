# P0-T3 report — shell spike (D-005: deno desktop vs Tauri)

**Recommendation: Tauri v2.** Both shells booted the real frontend stack (Vite 8 + React 19.2.7 + Base UI 1.6.0 + our fonts). Tauri worked first-try on every probe — dev loop, webview fidelity, native file-drop, child-process NDJSON streaming, packaging. The official `deno desktop` (Deno 2.9, released 16 days before this spike) is a genuinely exciting contender that keeps the whole product in TypeScript, but on this machine its window-creation deadlocks nondeterministically and its dev-mode path never survived long enough to load our app. It is not ready to carry the GUI today; D-005 should name a revisit trigger rather than close the door.

- Date: 2026-07-11 · Task: P0-T3 (`docs/internal/roadmap/p0.md`)
- Machine: Windows 11 Pro (10.0.26200), RTX 3090, Deno 2.9.2, rustc 1.95.0 + VS 2026 MSVC, WebView2 runtime 150.0.4078.65
- Shared probe app (identical in both shells + plain browser): Base UI **menu**, **dialog**, **number field with drag-scrubbing**, **Chakra Petch / IBM Plex Sans / IBM Plex Mono** (OFL, bundled), HTML5 + native **file-drop** zone, and a **mock core CLI** child process streaming the architecture's NDJSON event vocabulary into a verbatim log well. On boot the app self-tests (fonts loaded, 50-frame streaming job) and saves evidence through the active shell's bridge to `out/selftest-<shell>.json`.

## What "deno desktop" turned out to be (research finding)

Not the dormant community `webview_deno` (last release Jan 2025) — Deno 2.9.0 (June 25, 2026) shipped an official experimental **`deno desktop` subcommand**: `Deno.BrowserWindow`, in-process `win.bind()` page↔Deno RPC, `executeJs`, Vite autodetection with `--hmr`, and MSI/app-dir packaging with cross-compilation. Backend "laufey" (WebView2 on Windows / WebKitGTK on Linux / WKWebView on macOS), plus an optional CEF backend (~150 MB) that renders identically on all three OSes. This reshapes D-005: the Deno candidate is real, first-party, and strategically aligned (one language, shared types with core, `Deno.Command` is the best NDJSON child-process ergonomics of any option) — but it is 16 days old.

## Side-by-side results

| Probe | Tauri v2 (2.11.4, WebView2) | deno desktop (2.9.2, laufey 0.5.0) |
|---|---|---|
| Boot the real app | ✅ first try; selftest saved | ⚠️ constructor deadlock in every console-attached run; 1 of 3 detached packaged runs constructed, then process died seconds after `navigate()` — app never self-tested |
| Fonts (all 3 families) | ✅ `document.fonts.check` all true | — (app never loaded) |
| Base UI menu/dialog/scrub | ✅ rendered in WebView2 (Chromium 150); interactions verified in a Chromium browser against the same build | — (app never loaded) |
| Child process + NDJSON | ✅ Rust `Command` → per-line `emit`; 108 events from two concurrent jobs in 894 ms without loss (see StrictMode note) | Shell-side code written and type-checked (`Deno.Command` + line split, the cleanest of the three bridges); unverified end-to-end |
| Native file-drop (real paths) | ✅ API present (`tauri://drag-drop` with `paths[]`); interactive drop untested in automation | ❌ **no API** — HTML5 File objects only (documented gap); a "drop a glTF, hand the path to the core CLI" flow needs a byte-copy workaround |
| Dev loop | ✅ `tauri dev`: Vite HMR + cargo watch; first compile ~6 min (353 crates), then incremental | ⚠️ `--hmr` mode: **BrowserWindow constructor hung 100% of attempts** (minimal repro: `denoshell/test-window.ts`); type-checks bind callbacks (nice) |
| Packaging | ✅ NSIS installer — see numbers below | ⚠️ app-dir/MSI built fine (95.5 MB dir, 77 MB uncompressed dll; docs claim ~19 MB with `--compress`) but the packaged exe exhibits the same nondeterministic constructor hang |
| Windows evidence quality | Full (automated end-to-end) | Partial — see caveat below |

**Numbers (Tauri release build, Windows x64):**

| Metric | Value |
|---|---|
| NSIS installer | **2.22 MB** |
| Standalone exe | 8.12 MB (release, LTO+strip) |
| Release compile | 3 m 26 s (clean); dev incremental rebuilds are seconds |
| First dev compile | ~6 min (353 crates, once per machine/toolchain) |
| Cold start | **2.08 s** from process spawn to self-test saved — and the self-test itself includes a ~0.9 s 50-frame streaming job, so UI-ready is ≈1.2 s |
| Release self-test | 54/54 NDJSON events, no loss, all 3 font families loaded (also confirms the 108-event double was React StrictMode, dev-only) |

### The deno desktop failure, precisely

1. `deno desktop --hmr` from any console-attached shell (foreground or background): `new Deno.BrowserWindow()` never returns. Reproduced 5×, including a minimal script with no binds and no navigation (`denoshell/test-window.ts`). Everything before the constructor (permissions, file I/O, `Deno.Command` spawn) works.
2. Packaged exe, fully detached launch: constructed once (breadcrumb written ~2.6 s after spawn, navigate reached), then the process exited within ~5 s, before an 8 s probe timer — window closed or crashed; no unhandled-rejection/error breadcrumb fired. Two other detached launches deadlocked at the constructor.
3. Also hit: `import.meta.dirname` points into a fake embedded-compile path (`Temp\deno-compile-laufey_webview.exe`) — anchor paths to `Deno.cwd()`; the build refuses output-name collisions with existing directories; a running instance locks the shared per-project `shell.dll` cache, breaking rebuilds.

**Honesty caveat:** all launches came from automation-spawned shells (no interactive terminal, no visible confirmation of windows). The 100%-reproducible HMR hang and the post-navigate death are strong signals but deserve a 30-second interactive check: run the `README.md` denoshell command in a real terminal and see whether a window appears. Even if it does, the dev-loop deadlock from non-interactive contexts (CI, task runners, agents) stands as measured, on the same machine where Tauri + WebView2 worked flawlessly through the identical automation path.

### Notes from the working parts

- **Deno as the JS toolchain for Tauri works end-to-end**: `deno install` + `deno task --cwd ../app dev` as `beforeDevCommand`, `deno run -A npm:@tauri-apps/cli` — no Node needed anywhere. One trap: Deno anchors npm subpath resolution to the cwd, so Vite must be invoked from the app directory (`deno task --cwd`), not with a root positional arg.
- **StrictMode + global event channel**: React StrictMode double-ran the self-test effect, spawning two concurrent mock CLIs whose `job-line` events interleaved into both listeners (108 = 2×54 events, none lost). Harmless here, but the production bridge should use per-job channels (Tauri v2 `Channel` API), not a global event name.
- `@vitejs/plugin-react@5.1.4` doesn't declare Vite 8 peer support yet; works fine (rolldown-based Vite 8.1.4, 252 modules, 354 KB bundle).
- Base UI 1.6.0: the BOM's `@base-ui/react` package name is correct (the old `@base-ui-components/react` is a stale RC line). Menu/dialog/number-field APIs all work as documented; automated synthetic clicks need full pointer-event sequences (`pointerId`, `isPrimary`) to open the menu — keyboard/manual verification of menu-open is on the maintainer checklist below.

## Linux evidence gap (research-only; no local measurement — approved scope)

Both candidates use **WebKitGTK on Linux**, so webview fidelity does not differentiate them there; it is a shared, well-documented risk. Documented failure modes relevant to our stack, severity-ordered: (1) **NVIDIA + DMABUF compositing failures** (blank window, resize crashes) — officially documented by Tauri with env-var workarounds (`WEBKIT_DISABLE_DMABUF_RENDERER=1`) that production apps (e.g. GitButler) ship by default; (2) **WebGL silently falling back to software rasterization** with the renderer string masked (single-digit-FPS three.js reports) — this threatens our inspection viewports; the planned mitigation is that viewports can degrade to core-rendered PNG sequences, which D-002/D-004 make cheap; (3) **font-weight rendered ~100 heavier** than specified (upstream WebKitGTK bug, active 2026) plus animation/resize blur — cosmetic but visible in a look-dev tool; (4) IME composition problems under fcitx/ibus on Wayland — relevant to the Lingui i18n commitment. CSS *feature* availability is NOT the bottleneck — WebKitGTK 2.48–2.52 tracks upstream WebKit and Debian/Ubuntu push it into stable as security updates; Base UI depends on nothing Chromium-only. Tauri's bundled-Chromium escape hatch is unreleased (likely commercial); deno desktop's CEF backend is the only turnkey "identical rendering on Linux" option today, at ~150 MB and experimental status — a real strategic card if deno desktop matures.

**What only a Linux box can confirm:** actual three.js viewport FPS and whether the DMABUF fast path engages per GPU/driver; real font/scrubbing/IME behavior of our Base UI components; drag-drop path fidelity under Wayland vs X11 (deno desktop is X11-only via XWayland); whether `WEBKIT_DISABLE_DMABUF_RENDERER=1` must ship as a default. Recommended: a one-day Linux validation spike (VM + one NVIDIA box) before any Linux release commitment; Linux ships as tier-2 ("supported, with known webview caveats") until then. Windows is unaffected — WebView2 is mature Chromium.

## Maintainer checklist (5 minutes, interactive)

1. Run the Tauri dev command from `README.md`; verify by hand: menu opens on click/keyboard, dialog focus-trap, number-field **drag-scrubbing feel**, drop a file onto the well (should list a **native path**, `[native]` tag), Run mock bake streams lines.
2. Run the denoshell command in a real terminal — does a window appear at all? (Evidence either way; the spike's automation says the constructor usually deadlocks.)

## Drafted D-005 resolution (for `docs/internal/decisions.md`, maintainer to ratify)

> **D-005** — *resolved 2026-07-11 by P0-T3:* **Tauri v2** is the app shell. Both candidates booted the real stack (Vite+React 19+Base UI+fonts) in the spike harness. Tauri passed every probe first-try on Windows (WebView2): dev loop, fonts, Base UI widgets, native file-drop-with-paths, Rust-spawned core CLI with per-line NDJSON events, NSIS packaging — with Deno as the sole JS toolchain (no Node). The official `deno desktop` (new in Deno 2.9, 16 days old) is architecturally seductive — pure-TS shell, in-process bindings, best-in-class `Deno.Command` streaming, and a CEF backend that would neutralize the shared WebKitGTK-on-Linux risk — but it failed the spike on stability (nondeterministic `Deno.BrowserWindow` constructor deadlock, 100% in console-attached/dev-loop contexts; packaged-run death after navigate) and lacks native file-drop paths. **Revisit trigger** (non-binding note, not a commitment): if by p4 (GUI phase) deno desktop has stabilized window creation, shipped native file dialogs/drop-paths, and survived two Deno minor releases without desktop regressions, re-run this spike's harness — the shared probe app and bridge are shell-agnostic by construction, so the swap cost is one bridge implementation. Linux webview fidelity is a shared WebKitGTK risk either way (documented in `spikes/shell/REPORT.md`); Linux ships tier-2 until a one-day Linux validation spike runs. Riders: pin the Tauri crate/CLI minor; per-job IPC channels (not global event names) in the production bridge; the GUI's `render`-adjacent viewports must be able to degrade to core-rendered PNG sequences (already implied by D-002/D-006).

## Reproduce

See [README.md](./README.md). Evidence files: `out/selftest-tauri-dev.json` (dev build), `out/selftest-tauri.json` (release build), `out/denoshell-*.json` breadcrumbs, `denoshell/test-window.ts` (constructor-hang minimal repro).
