# Platform support & targets

The latest source-checkout qualification is the
[2026-10-19 F0 baseline](../future/baseline.md#preserved-platform-targets): native Windows x64
Vulkan rendering, source checks and explicit diagnostic failures. Other hardware and installed
artifacts remain unverified in that run. The targets below remain product commitments, not claims
that F0 executed every platform.

This page is for contributors working in the repository. The release zips do not include the
repository, and the commands here assume a checkout.

Standing constraint: ship **Windows x64, Windows ARM64, and macOS**; prioritize the Windows dev box
today, but make decisions with macOS in mind. Linux is tier-2 until the webview validation spike
runs (see D-005 riders).

## Target matrix (state as of 2026-07-12, Deno 2.9.2)

| Layer                          | win-x64                           | win-arm64                                                                                                | macOS (arm64/x64)                                          | Linux x64                                |
| ------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| Deno runtime (dev/test)        | ✅                                | ⚠ x64 build under emulation                                                                              | ✅ both                                                    | ✅                                       |
| `deno compile` (CLI binaries)  | ✅ `x86_64-pc-windows-msvc`       | ❌ **no `aarch64-pc-windows-msvc` target** — ship x64 binary (Windows-on-ARM emulates x64 well)          | ✅ `aarch64-apple-darwin` + `x86_64-apple-darwin`          | ✅ x64 + arm64                           |
| WebGPU backend (core renderer) | Vulkan (pinned on dev box) / dx12 | dx12 under emulation — unmeasured                                                                        | Metal (via wgpu) — unmeasured locally, no Mac hardware yet | Vulkan; CI uses Mesa lavapipe (software) |
| Tauri shell                    | ✅ NSIS x64                       | ✅ NSIS arm64 (Tauri supports the target; our deno-compiled sidecar CLI would be the x64-emulated piece) | ✅ universal dmg                                           | ✅ (webview fidelity caveats — D-005)    |
| AI sidecar (UniRig etc.)       | ✅ CUDA                           | ❌ CUDA-only models                                                                                      | ❌ CUDA-only (registry platform gates — D-009)             | ✅ CUDA                                  |

## What CI covers vs what needs hardware

- **CI (free hosted runners):** lint/format/tests on ubuntu, macos (arm64), windows (x64); ubuntu
  lane with Mesa lavapipe installed (render suites attach from P2).
- **Not covered:** win-arm64 (the `windows-11-arm` hosted runner is free for public repos only; this
  repo is private) — and `deno compile` can't target it anyway yet; macOS GPU rendering (needs Mac
  hardware or GPU CI — the webgpu spike doubles as the canary to run there when available); Linux
  desktop webview fidelity (one-day validation spike before any Linux release commitment).

## Re-check triggers

1. Deno adds `aarch64-pc-windows-msvc` to `deno compile` → add native win-arm64 CLI builds.
2. Repo goes public → enable the `windows-11-arm` runner lane.
3. Mac hardware (or GPU CI) available → run `deno task test:gpu` on Metal and record results
   alongside the Windows baselines. Retired spike measurements remain available in Git history.
4. Any Deno upgrade → re-run `deno task test:gpu` first (D-004 canary rider).
