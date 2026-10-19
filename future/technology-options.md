# Desktop and language decisions

Research date: **2026-10-18**. **The maintainer has selected Tauri and TypeScript, with Deno to be
replaced.** Those choices are settled for this migration. The earlier alternative-toolkit research
is retained below as historical context, not an active selection process. No toolkit, installer,
screen reader, GPU or model was run for this memo.

## Recommendation

**Migrate this repository in place, preserving the TypeScript core and the existing React UI in
Tauri.** This strategy is now approved. The [repository decision](migration-strategy.md) records
why, and the [migration roadmap](roadmap.md) sets one execution order with concrete acceptance
gates.

Recommend Node LTS for the replacement runtime and qualify Node/Dawn first for the existing
TypeScript renderer. Keep a narrow Rust/wgpu render worker only as a contingency if a documented
GPU/platform/packaging gate fails; adopting it would need a separate decision. Tauri's existing Rust
host and Python/native inference processes remain compatible with a TypeScript product core. Full
Rust core, GPUI, Slint/iced, and separate native OS shells are not migration tasks.

The [runtime review](runtime-migration.md) owns the Deno-specific replacement surface and GPU gates.
Do not reopen the chosen desktop/language as a prerequisite for delivering that migration.

The companion [model-management review](model-management.md) evaluates the actual Hugging Face
integration independently of the UI/runtime choice.

## What the repository actually uses

| Area            | Evidence in this checkout                                                                                                                                                                 | Consequence for a remake                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop         | [Tauri manifest](../apps/studio/src-tauri/Cargo.toml), [React bridge](../apps/studio/src/bridge.ts), and [Rust shell](../apps/studio/src-tauri/src/main.rs)                               | A Rust host and a process boundary already exist. Rust adoption does not require replacing React.                                                                        |
| Real jobs       | `run_cli` invokes ambient `deno run -A` against a checkout, appends session logs, emits per-job stdout events, and discards stderr                                                        | Installed worker discovery, cancellation, diagnostics, and permissions need redesign whichever UI wins. A new toolkit would otherwise inherit the same delivery problem. |
| Packaging       | [Tauri configuration](../apps/studio/src-tauri/tauri.conf.json) selects NSIS only, uses Deno build hooks, and sets `csp: null`; the shell falls back to a compiled-in repository location | The current app is not evidence of complete clean-machine delivery across all target OSes. Preserve useful behavior, then replace development assumptions.               |
| Platform intent | [Platform support](../docs/platform-support.md) targets Windows x64/ARM64 and macOS, with Linux tier 2 and important GPU paths unmeasured                                                 | Distinguish a target from a tested release. Evaluate ARM64 independently of Windows x64.                                                                                 |
| 3D inspection   | [MeshViewport](../apps/studio/src/viewport/meshviewport.ts) uses three.js WebGPURenderer, camera-controls, glTF loading, bone overlays, animation playback, and TransformControls         | A native UI rewrite must replace substantial interaction behavior, not just the React layout.                                                                            |
| Sprite truth    | [Architecture](../docs/architecture/architecture.md) and [viewport skill](../.agents/skills/threejs-editor-viewport/SKILL.md) separate mesh inspection from core-rendered sprites         | Every candidate can show core PNGs; interactive rig repair still needs a credible 3D inspector.                                                                          |

The broad `run_cli` interface, file-reading commands, and disabled CSP deserve a bounded trust
review during the shell migration. Restrict installed worker paths, command arguments, workspace
roots, navigation, and IPC payload sizes; preserve actionable failures and raw job events. This is a
concrete review surface identified in the source, not a claim that an exploit was demonstrated.

## The decision is about boundaries, not one language

The product has at least four different jobs: durable manifests and scheduling, GPU rendering,
desktop interaction, and model inference. One language does not eliminate those seams. Python and
model-specific native extensions remain necessary for the currently integrated AI stacks; changing
TypeScript to Rust does not turn CUDA kernels into Metal kernels. The current
[catalog](../packages/registry/catalog/models.json) correctly limits real generation and UniRig to
CUDA platforms, while CPU fixtures and image prep have wider support.

Native Node/Dawn is a credible candidate on ARM as well as x64. The current `node-webgpu`
[build workflow](https://github.com/dawn-gpu/node-webgpu/blob/main/.github/workflows/build.yml)
explicitly builds/tests `win32-arm64`, `linux-arm64`, `darwin-universal`, `win32-x64`, and
`linux-x64`, using Node 24. Its current source
[package manifest](https://github.com/dawn-gpu/node-webgpu/blob/main/package.json) identifies the
package as `webgpu` **0.6.1**. This is source-level build coverage, not a claim that we installed or
verified any published artifact. Windows ARM64 is an installation/rendering gate for both
candidates, not a reason to dismiss Node/Dawn as x64-only.

## Earlier stack alternatives (historical)

The earlier comparison is resolved for this migration. Only the Tauri/TypeScript direction is
selected; no alternate toolkit or full-core language experiment is scheduled.

| Earlier option                                 | Current status                                                 | Reason                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **A. TypeScript core + React/Tauri**           | **Tauri and TypeScript confirmed**; recommend preserving React | Retains the selected stack and implemented behavior; Node LTS and Node/Dawn still need qualification |
| **B. Rust core + React/Tauri**                 | Not selected                                                   | Replaces the TypeScript core the maintainer has chosen to keep                                       |
| **C. Rust core + GPUI Kit**                    | Not selected                                                   | Replaces both settled boundaries and adds an editor/inspector port                                   |
| **D. Rust core + Slint or iced**               | Not selected                                                   | Reopens settled choices; the earlier toolkit/license findings remain historical context              |
| **E. Shared core + separate native OS shells** | Not selected                                                   | Tauri is retained; duplicate UI/release ownership and a separate Linux UI decision are unnecessary   |

Keep manifests independent of toolkit state, but do not schedule a core-language or native-editor
migration on the assumption that the current decision will change.

## What gpui-kit.com is today

**Historical research only.** No GPUI evaluation, editor port or inspector spike is planned under
the selected Tauri/TypeScript scope. The following source findings preserve the original comparison.

The user-specified [GPUI Kit](https://gpui-kit.com/) is Longbridge's current project. The
[former gpui-component documentation](https://longbridge.github.io/gpui-component/) explicitly
points to it. It is **not a third unrelated toolkit** competing with Longbridge gpui-component.
Within the current project, `gpui-kit` is the application-facing crate, `gpui-component` is the
styled component layer, and `gpui-base` owns reusable behavior. Upstream GPUI remains Zed's
GPU-accelerated Rust UI foundation. [GPUI Kit source](https://github.com/longbridge/gpui-kit),
[upstream GPUI](https://gpui.rs/).

The published [v0.7.3 release](https://gpui-kit.com/releases/) is dated **2026-10-12** and pins the
`gpui-pre` **0.3.9** snapshot, based on Zed commit `93d7456`; v0.7.2 was yanked. Software and code
examples use Apache-2.0. Documentation prose has separate terms; software adoption still requires a
full dependency/asset license inventory under SpriteBook's existing rules.
[License](https://github.com/longbridge/gpui-kit/blob/main/LICENSE-APACHE),
[repository license explanation](https://github.com/longbridge/gpui-kit#license).

### Components and platform fit

The site advertises **75+ components and primitives**, including docking, virtualized lists and
tables, inputs, color controls, themes, and an editor. Those are a plausible match for a dense
sprite editor. This is evidence of component breadth, not a SpriteBook quality benchmark; the public
gallery is not proof of our rig editor, translation coverage, or focus flows.
[Component overview](https://gpui-kit.com/).

Current installation documentation names macOS **15+**, Windows **10+**, and Linux; its locked graph
requires Rust **1.92+**. Linux requires a graphical Wayland/X11 session and working Vulkan driver,
with Ubuntu 24.04 as the documented package baseline. These requirements would need to fit our
chosen support matrix. They do not establish Windows ARM64 application delivery.
[Installation guide](https://gpui-kit.com/docs/installation/).

GPUI draws its UI on the GPU; “native” here does not mean every widget is an AppKit or WinUI
control. Platform services still exist: GPUI's current source documents Metal on macOS, Win32 and
DirectWrite on Windows, and explicit X11/Wayland feature selection on Linux.
[GPUI platform documentation](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md).

### Accessibility, text input, menus, and packaging

GPUI Kit exposes AccessKit roles, names, values, actions, and standard control semantics, and has
headless interaction tests. Its own accessibility guide explicitly requires real keyboard and
assistive-technology verification beyond semantic-tree tests. Require VoiceOver, NVDA, and Linux
assistive-technology checks on our actual flows; a role annotation alone cannot prove AA
accessibility. [Accessibility guide](https://gpui-kit.com/docs/accessibility/).

Recent releases include IME, candidate-position, text-selection, focus, and menu fixes. That is
active support for desktop input, and also a reason to pin versions and test Chinese/Japanese/
Korean composition, accented text, undo grouping, Unicode filenames, clipboard, and selection on
each platform. [Release notes](https://gpui-kit.com/releases/).

Its native popup integration uses AppKit on macOS and Win32 on Windows, while Linux currently uses a
GPUI popup constrained by the window. Do not promise identical native menu behavior across all
three. [Native extensions](https://gpui-kit.com/docs/native-extension/).

GPUI Kit leaves the application's installer, identity, assets, signing, and release testing to the
application. A release binary alone is insufficient: the app still needs a notarized Mac bundle, a
signed Windows delivery route, Linux dependencies, upgrades, and uninstall tests. Tauri already
provides distribution tooling for those platform formats; SpriteBook currently wires only part of
it. [GPUI packaging](https://gpui-kit.com/docs/packaging/),
[Tauri distribution](https://v2.tauri.app/distribute/).

### The 3D viewport is the deciding technical risk

There are three possible strategies for a GPUI editor:

1. **Native inspector backed by the shared renderer.** Build orbit, joint picking, gizmos, animation
   playback, and image presentation over canonical assets. This best preserves the existing product
   boundary but needs a real implementation spike, including GPU device, texture ownership, resize,
   synchronization, and failure recovery. Shared use of Rust does not prove that GPUI and the render
   worker can share a texture or device cheaply.
2. **Embedded three.js inspector.** GPUI Kit's experimental `gpui-wry` currently covers Mac and
   Windows; the Linux hosting path is unfinished. Native child webviews cover GPUI overlays in their
   rectangle, and the Windows example requires a renderer setting. This is not a proven all-platform
   bridge for our dialogs, bone menus, and gizmos.
   [WebView integration and limitations](https://gpui-kit.com/docs/webview/).
3. **Core PNG sequences only.** Suitable for sprite truth and fallback inspection. Insufficient by
   itself for the current interactive rig-repair feature set unless that interaction is explicitly
   reimplemented. Preserve the distinction between a temporary fallback and a feature-complete
   native editor.

GPUI Kit's optional JavaScript extension layer is not a reason to transplant the existing React
application: it hosts scripts drawing its own UI, not a browser DOM. There is no requested plugin
product here; keep it out of the initial remake.
[Kit architecture](https://github.com/longbridge/gpui-kit).

## Engineering implications of the selected Tauri shell

Tauri uses WebView2 on Windows, WKWebView on macOS, and WebKitGTK on Linux. That saves a bundled
browser but creates a web-engine matrix; macOS webview updates follow the OS, and Linux depends on
distribution packages. Test the actual app/webview combinations rather than assuming Chrome
behavior. [Tauri webview versions](https://v2.tauri.app/reference/webview-versions/).

For SpriteBook the core render worker can make final sprites independent of that matrix. React
continues displaying those pixels and can reuse the current three.js inspector. Native menu, dialog,
file association, and window integration can be added in the Rust host without rewriting the whole
app; Tauri documents both [window menus](https://v2.tauri.app/learn/window-menu/) and
[external binaries](https://v2.tauri.app/develop/sidecar/).

The cost is continued web layout and embedded-browser debugging. DOM accessibility is a useful
starting point, not proof of desktop assistive-technology behavior. Base UI, browser audits, and
existing proof tools should carry forward, with native VoiceOver/NVDA and IME testing added.
Redesign the workflow and visual hierarchy independently of this implementation choice.

## Unselected alternatives and their limits

The alternatives below are historical context. None is scheduled or required for the selected
Tauri/TypeScript migration.

| Choice               | Source-backed position                                                                                                                                                                                                                                                   | Judgment for SpriteBook                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **iced**             | MIT; Rust, Windows/macOS/Linux, wgpu and software renderers; the project still labels itself experimental. A custom shader widget exposes wgpu work. [Project](https://github.com/iced-rs/iced), [shader API](https://docs.rs/iced/latest/iced/widget/shader/index.html) | Credible native rendering fallback. Validate docking, advanced editor controls, IME, real accessibility, and our GPU composition; Rust alone does not supply them. No comparative benchmark was run.                                     |
| **Slint**            | Rust/C++ and other bindings; cross-platform desktop; GPLv3, royalty-free, or commercial terms rather than the project's permitted bundled-license set. [FAQ](https://slint.dev/faqs), [license explanation](https://slint.dev/blog/making-slint-desktop-ready)           | A serious toolkit, but currently outside the dependency policy without an explicit policy decision. Its declarative UI is a full rewrite and adds a UI language. Do not silently approve it because a desktop license is free of charge. |
| **Qt**               | Documented Windows/macOS/Linux support, with commercial and open-source LGPL/GPL licensing by module. [Platforms](https://doc.qt.io/qt-6/supported-platforms.html), [licensing](https://doc.qt.io/qt-6/licensing.html)                                                   | The mature desktop/control option if we consciously change the license policy and accept Qt/C++/QML or binding maintenance. It is not admissible under today's permissive dependency whitelist simply because SpriteBook itself is AGPL. |
| **SwiftUI + AppKit** | SwiftUI can host AppKit views through NSViewRepresentable. [Apple API](https://developer.apple.com/documentation/swiftui/nsviewrepresentable)                                                                                                                            | Strongest Mac-specific control; a custom native GPU view can live beside standard controls. Still needs renderer integration, engine IPC/FFI, and an independent Windows UI.                                                             |
| **WinUI 3**          | Microsoft's desktop framework, available through Windows App SDK with C# or C++ development paths. [Microsoft overview](https://learn.microsoft.com/en-us/windows/apps/winui/winui3/)                                                                                    | Strongest Windows-first platform alignment. Choose C# or C++ UI bindings deliberately; it is not a Rust-only cross-platform answer.                                                                                                      |

With separate platform apps, retain one shared command/manifest contract and one render engine.
Otherwise a bug in sprite packing or license gating is fixed twice. UI duplication remains even with
a shared core: stage navigation, parameter forms, undo presentation, model manager, log drawer,
shortcuts, help, localization, tests, and release behavior all have two owners. Linux then adds
another GUI implementation or becomes an explicit headless-only tier. That is a product and staffing
decision, not an incidental build target.

## Validation for the selected stack

These are technical acceptance requirements for Tauri and the TypeScript core, applied by the
[migration roadmap](roadmap.md). They are not completed measurements or delivery estimates.

- **Node/Dawn qualification:** run the actual shader/AOV/readback path and representative rigged
  assets, preserve structural and tolerant image checks, record GPU identity and memory/throughput,
  and test installed artifacts across the claimed OS/CPU targets. Deno is the reference, not a
  permanent production dependency. Investigate a native render worker only for a documented failure.
- **Packaged Tauri execution:** launch without a checkout or developer PATH; import a mesh; run and
  cancel a job; surface raw errors; display core sprites; reopen the workspace; and prove conversion
  and rollback on a preserved copy.
- **Existing inspector continuity:** retain three.js orbit, textured/clay/wire modes,
  core-retargeted playback, joint picking/nudging, and safe disposal. No native inspector rewrite is
  required by the selected shell.
- **Interaction and release quality:** keyboard-only completion, VoiceOver/NVDA and any claimed
  Linux assistive-technology path, IME, clipboard, file drop, menus, focus restoration, scale
  changes, signing/notarization, upgrade and uninstall. Include native Windows ARM64 delivery or
  label emulation honestly.

Choosing this repository does not waive these gates. Failure is addressed at the specific runtime,
GPU, process or packaging boundary rather than triggering a new desktop/core-language selection.

## Limits of this assessment

No comparative application benchmark, Mac/ARM hardware run, live accessibility audit, or installer
execution was performed. Version, platform, and license claims above are a dated upstream-document/
source review and must be rechecked at implementation time. This update records the maintainer's
Tauri/TypeScript/Deno-exit decision; it does not implement a runtime or adopt new dependencies.
