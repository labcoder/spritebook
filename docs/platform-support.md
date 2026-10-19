# Platform support & targets

The [2026-10-19 F0 baseline](../future/baseline.md#preserved-platform-targets) records the
production Deno control. The newer [F2 proof](../future/renderer-qualification.md) runs the existing
renderer on Node/Dawn through a Windows x64 Vulkan installer, including image/performance and
installed failure/recovery checks. It is an isolated qualification build; the production CLI/editor
still run Deno. Native Windows ARM64, macOS ARM64/Intel and Linux qualification are deferred to F7
by the maintainer's confirmed Windows-only F2 scope. Clean-machine prerequisites, signing and native
notice clearance remain release gates. The targets below remain product commitments, not claims that
this session executed every platform.

This page is for contributors working in the repository. The release zips do not include the
repository, and the commands here assume a checkout.

Standing constraint: ship **Windows x64, Windows ARM64, and macOS**; prioritize the Windows dev box
today, but make decisions with macOS in mind. Linux is tier-2 until the webview validation spike
runs (see D-005 riders).

## Historical production target matrix (2026-07-12, Deno 2.9.2)

| Layer                          | win-x64                           | win-arm64                                                                                                | macOS (arm64/x64)                                          | Linux x64                                |
| ------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| Deno runtime (dev/test)        | ✅                                | ⚠ x64 build under emulation                                                                              | ✅ both                                                    | ✅                                       |
| `deno compile` (CLI binaries)  | ✅ `x86_64-pc-windows-msvc`       | ❌ **no `aarch64-pc-windows-msvc` target** — ship x64 binary (Windows-on-ARM emulates x64 well)          | ✅ `aarch64-apple-darwin` + `x86_64-apple-darwin`          | ✅ x64 + arm64                           |
| WebGPU backend (core renderer) | Vulkan (pinned on dev box) / dx12 | dx12 under emulation — unmeasured                                                                        | Metal (via wgpu) — unmeasured locally, no Mac hardware yet | Vulkan; CI uses Mesa lavapipe (software) |
| Tauri shell                    | ✅ NSIS x64                       | ✅ NSIS arm64 (Tauri supports the target; our deno-compiled sidecar CLI would be the x64-emulated piece) | ✅ universal dmg                                           | ✅ (webview fidelity caveats — D-005)    |
| AI sidecar (UniRig etc.)       | ✅ CUDA                           | ❌ CUDA-only models                                                                                      | ❌ CUDA-only (registry platform gates — D-009)             | ✅ CUDA                                  |

## What CI covers vs what needs hardware

- **Declared source lanes:** lint/format, tests on Ubuntu/macOS/Windows and Linux Mesa lavapipe in
  [ci.yml](../.github/workflows/ci.yml). They still execute Deno. Their presence is not a report of
  a fresh remote run; F4-T4 must port them to Node.
- **Useful hosted checks:** native OS builds, non-GPU behavior and Linux software Vulkan smoke/
  structural checks. These can run without a personally owned Mac or Linux machine.
- **Deferred qualification:** native ARM64, Metal and Linux hardware rendering/performance;
  installed desktop behavior, clean-machine prerequisites and platform accessibility. Use suitable
  native hardware or a configured GPU runner, record its actual adapter, and execute the installed
  artifact. Build success and software rasterization do not establish hardware/desktop support. See
  the
  [runner plan and primary sources](../future/renderer-qualification.md#deferred-platform-checks).

## Re-check triggers

1. Any Node/Dawn, shader or PNG-boundary change → repeat the affected renderer assertions, image
   comparisons and installed Windows checks before promoting it.
2. F4 tooling cutover → port the existing OS/software-Vulkan lanes and preserve honest GPU
   failure/skip behavior. Keep the historical Deno control for comparison.
3. Native hardware or configured GPU CI becomes available → execute F7's deferred workload and
   installed checks on each target, recording actual CPU/backend/adapter and limitations.
4. Any legacy Deno upgrade before retirement → re-run `deno task test:gpu` first (D-004 canary
   rider).
