# Development

## Prerequisites

- Node **24.22.0**, pinned in `.node-version`, and npm.
- Rust/Cargo and [Tauri's platform build prerequisites](https://v2.tauri.app/start/prerequisites/).
  Windows builds need MSVC C++ tools and the Windows SDK, including `mt.exe`.
- uv **0.12.10** for source-side Python/model work. See the
  [sidecar guide](../../sidecar/README.md).

AI model weights and CUDA environments are optional, separate installs. You can build the editor,
run ordinary tests and use the bundled authored example without downloading generation models.

## Run the app

From the repository root:

```sh
npm ci --ignore-scripts
npm run dev:desktop
```

The Tauri development command prepares the core and owned runtime, then starts Studio with its real
native bridge. For UI-only work:

```sh
npm run dev:web -w spritebook-studio
```

The browser preview uses labeled demo data on port 5174. It does not exercise native dialogs,
process ownership or real workspace jobs. Use the desktop build for those checks.

## Build

```sh
npm run build
npm run build:web -w spritebook-studio
npm run build:runtime
npm run build:desktop
```

`build` compiles the small native ownership helpers, TypeScript packages and runtime assets.
`build:runtime` stages a complete portable CLI at `.build/runtime/`. `build:desktop` produces the
Windows installer under `apps/studio/src-tauri/target/release/bundle/nsis/`.

The installed app owns Node and uv. It does not require end users to install Node, Rust, Git or a
compiler. Python/model environments live in writable application data and install on demand. Windows
archive extraction uses the OS-provided `System32/tar.exe`, independent of Git/MSYS tools on `PATH`.

Use `npm run cli -- <verb> ...` to call the emitted CLI from a checkout. `npm run build:watch` and
`npm run test:watch` support iterative core work; tests exercise emitted modules.

## Checks

| Command                                                               | Purpose                                           |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `npm run fmt:check`                                                   | Formatting                                        |
| `npm run lint`                                                        | Lint                                              |
| `npm run check`                                                       | Separate core, Studio and test type checks        |
| `npm test`                                                            | Normal suites, with explicit optional-lane skips  |
| `npm run coverage`                                                    | Coverage report in `.coverage/`                   |
| `npm run test:gpu`                                                    | Renderer/style checks with a working adapter      |
| `npm run test:real`                                                   | Installed real-backend integration checks         |
| `npm run i18n:extract -w spritebook-studio`                           | Translatable strings and Spanish catalog coverage |
| `cargo test --locked --manifest-path packages/core/native/Cargo.toml` | Native process/lock ownership                     |

The real-backend lane needs the exact catalog models and prepared runtimes. Engine checks need the
external programs listed in [export validation](export-validation.md). A skipped lane does not
establish support. Run performance measurements with competing GPU workloads stopped so the timings
describe SpriteBook rather than resource contention.

Hosted [CI](../../.github/workflows/ci.yml) checks source on Windows, macOS and Ubuntu. A separate
Linux lavapipe lane exercises software rendering. The
[candidate workflow](../../.github/workflows/release.yml) builds copied runtime payloads and the
Windows installer. See [platform support](../platform-support.md) for what these checks qualify.

## Generated files and disk use

`node_modules/`, package `dist/`, `.build/`, `.coverage/`, `.render-bench/` and Cargo target
directories are generated development data. Keep experiments and qualification reports in the
management workspace, outside this repository. Preserve selected screenshots or small fixtures only
when public documentation or tests need them.

To clean native build output:

```sh
cargo clean --manifest-path apps/studio/src-tauri/Cargo.toml
cargo clean --manifest-path packages/core/native/Cargo.toml
```

Cleaning build output does not uninstall model weights or writable runtime environments. Follow
[model storage and removal](../user/models.md#storage-and-removal) for those; preserve character
workspaces and original inputs.
