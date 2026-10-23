# Platform support and qualification

The TypeScript core/CLI and Tauri bridge now use app-owned Node 24.22.0 and Dawn 0.6.2.
[Windows cutover evidence](../future/runtime-cutover.md) and the
[original F2 proof](../future/renderer-qualification.md) distinguish actual runs from declared
targets. The maintainer deferred native Mac, Windows ARM64 and Linux qualification to F7 because
only the Windows x64 machine is available locally. Builds and software rendering do not close those
gates.

| Layer              | Windows x64                                                                      | Windows ARM64                                  | macOS ARM64 / Intel                                       | Linux                                                       |
| ------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| Node core/CLI      | Local and hosted tests; copied payload executed                                  | Target; native addon/loader recipe unqualified | Hosted native copied-payload checks on both architectures | Hosted native copied payload and lavapipe execution         |
| GPU renderer       | NVIDIA RTX 3090, Vulkan, driver 610.88; paired image/performance checks pass     | F7 native hardware gate                        | F7 Metal gate, architectures recorded separately          | F7 hardware gate; lavapipe is software evidence only        |
| Tauri desktop      | Windows build/integration qualification in F4                                    | F7 native installed-app gate                   | F7 native installed-app gate                              | Tier 2; F7 WebKitGTK/installed-app gate                     |
| Base Python/uv     | Fresh writable environment and real U²-Net prep executed                         | CPU target, not run here                       | CPU target, not run here                                  | CPU target, not run here                                    |
| TRELLIS.2 / UniRig | Complete managed CUDA setup and installed offline workflow qualified on RTX 3090 | Current CUDA recipes unavailable               | Current CUDA recipes unavailable                          | Historical CUDA entries; complete native setup unqualified  |
| Pixal3D            | Optional managed CUDA setup and installed offline workflow qualified on RTX 3090 | Current CUDA recipe unavailable                | Community ports researched; no catalog runtime            | Upstream CUDA path researched; no qualified catalog runtime |

The model workflows above use exact recipes and configuration-specific admission. They do not
qualify every NVIDIA card or every upstream mode. [Model management](models.md) lists file sizes,
memory requirements and available operations; the
[platform spike](../future/model-platform-spike.md) separates upstream claims, experimental ports
and local measurements. Model availability is independent of CLI/render and desktop availability.

Model detection reports macOS CPU conservatively until the selected backend has verified its own
accelerator. Neither an Intel/Apple Silicon host nor the renderer's Metal device proves that a
Python model supports MPS. CUDA presence is likewise only a candidate lane: exact architecture and
runtime kernel admission still apply. Driver probes have a bounded timeout; unsupported operating
systems cannot inherit Linux recipes. These checks do not constitute new native platform execution
evidence.

## What CI covers

[CI](../.github/workflows/ci.yml) uses Node for formatting, linting, separate type checks and tests
on Ubuntu/macOS/Windows. Its Linux lavapipe lane requires an adapter and runs renderer structural
and image checks. The [candidate workflow](../.github/workflows/release.yml) builds owned CLI trees
on native hosted OS runners and a Windows NSIS candidate, then exercises copied CLI trees with an
empty PATH. Intel and ARM Mac jobs use separate runner labels. Definitions are committed; they were
executed for the 0.5.0 preview.
[Fresh source CI](https://github.com/labcoder/spritebook/actions/runs/39990823015) passes on
Windows/macOS/Ubuntu, including Linux software rendering. Candidate native payload and installer
results are recorded by the release workflow. Source fixtures and copied-payload checks do not
qualify native consumer GPU performance, downloaded models or installed Mac/Linux desktops.

The [v0.5.0 candidate run](https://github.com/labcoder/spritebook/actions/runs/39992515204) passes
all four native CLI payload jobs and the Windows installer build. The matching
[source CI](https://github.com/labcoder/spritebook/actions/runs/39992511449) is also green.

F7 still needs end-user installed-desktop qualification, native GPU/performance measurements,
installer recovery, clean-machine runtime prerequisites, signing/notarization, notices and native
accessibility. The Windows Vulkan payload excludes DXC/FXC; private Direct3D experiments confer no
redistribution clearance. Windows ARM64 needs its own loader/addon qualification; x64 emulation is
separate evidence.

## Re-check triggers

- Node/Dawn, codec, shader or renderer changes: repeat affected structural assertions, reviewed
  image comparisons and installed Windows checks. Never reuse an old cache as renderer evidence.
- Native hardware or configured GPU CI becomes available: execute F7's workload and installed
  checks, recording actual OS, architecture, backend, adapter, driver and limitations.
- Driver-only changes without an exposed identity change: use an empty render cache.
- Legacy comparison or rollback: archive the pinned source commit into a separate checkout and use
  preserved workspace copies. Legacy Deno commands are reference-only, never normal development.
