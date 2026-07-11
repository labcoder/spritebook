# Draft comment for denoland/deno#35645 (maintainer to review & post)

Update after upstream research: the root cause is already fixed — [laufey#35](https://github.com/littledivy/laufey/pull/35)
(recursive mutex, in laufey 0.5.1/0.6.0), bundled into deno main by
[#35859](https://github.com/denoland/deno/pull/35859) but not in stable 2.9.2. The
value of posting the notes below on #35645 is the **new repro signal**: with a console
attached (foreground terminal or redirected stdio) the constructor deadlock is
deterministic (5/5); fully detached it is intermittent (2/3 deadlock, 1/3 constructs
then aborts 0xc0000409 at first page load). That determinism pattern is not documented
upstream and may help the maintainers' e2e coverage (laufey 0.6.0 added e2e tests).

---

**Original observation notes (Deno 2.9.2 stable, laufey 0.5.0):**

## Environment

- Deno 2.9.2 (stable, x86_64-pc-windows-msvc), laufey webview backend v0.5.0
- Windows 11 Pro 10.0.26200, WebView2 Evergreen runtime **150.0.4078.65**
- GPU: NVIDIA RTX 3090, driver 32.0.16.1047

## Repro A — backend crash (~10 s, deterministic on this machine)

```ts
// serve-only.ts — no BrowserWindow; bootstrap window auto-navigates to Deno.serve
Deno.serve(() =>
  new Response('<!doctype html><h1>hi</h1>', { headers: { 'content-type': 'text/html' } }));
```

```
deno desktop --hmr serve-only.ts
```

Output: `Listening on http://127.0.0.1:<port>/` → the webview fetches the page (server
receives GET with the WebView2 UA, page renders) → within ~5 s:

```
error: LAUFEY backend exited with status: exit code: 0xc0000409
```

Windows Error Reporting (packaged variant, same crash): exception 0xc0000409
(fail-fast) in `ucrtbase.dll`, faulting app = the built app exe. `RUST_LOG=debug`
adds no backend output.

## Repro B — constructor deadlock (most runs)

```ts
console.log('constructing…');
const win = new Deno.BrowserWindow({ title: 'diag', width: 400, height: 300 });
console.log('constructed OK'); // never prints in most runs
```

`constructing…` prints; the constructor never returns (reproduced 5/5 with console
attached / redirected stdio; intermittently also when launched detached). Presumably
the API awaits a handshake with a backend that wedged or crashed at startup —
consistent with Repro A.

## Notes

- The **CEF backend works** on the same machine/script (`--backend cef`): window up,
  page served, app stable — though Chromium's GPU child process crashes 3× at startup
  (`GPU process exited unexpectedly: exit_code=-2147483645`) and falls back to software
  rendering, which may point at the same GPU-adjacent trigger that fail-fasts the
  single-process webview backend.
- WebView2 itself is healthy on this machine: a Tauri v2 app (wry/WebView2) runs the
  identical frontend flawlessly from the same shell contexts.
- Possibly related to the 2.9.1 "repair webview and raw backends on Windows" fix area;
  WebView2 150.x is a very recent Evergreen runtime.
