# Platform support

**The desktop application is a Windows x64 preview.** Native desktop, GPU and model workflows on
Mac, Linux and Windows ARM64 remain unqualified. CI checks additional operating systems, but a
successful build or copied CLI smoke test is a narrower result than a complete installed app.

## Current support by layer

| Layer                     | Windows x64                                                                         | Windows ARM64                     | macOS Intel / Apple Silicon                                                | Linux                                                       |
| ------------------------- | ----------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Core/CLI                  | Local and hosted tests; copied payload execution                                    | Native loader/addon not qualified | Hosted tests; separate native copied-payload checks for both architectures | Hosted tests and copied payload execution                   |
| GPU rendering             | Recorded NVIDIA RTX 3090/Vulkan checks                                              | Hardware gate open                | Metal hardware gate open                                                   | Software lavapipe checks; consumer GPU gate open            |
| Tauri desktop             | Windows installer and integration checks                                            | Installed app not qualified       | Installed app not qualified                                                | Installed app/WebKitGTK not qualified                       |
| Python preparation        | Fresh environment and real U²-Net execution                                         | Not qualified                     | Not qualified                                                              | Not qualified                                               |
| TRELLIS.2 / UniRig        | Managed CUDA setup and offline model workflow checked on the recorded configuration | Current CUDA recipes unavailable  | Current CUDA recipes unavailable                                           | Historical entries; complete native setup not qualified     |
| Pixal3D                   | Managed CUDA setup and offline workflow checked on the recorded configuration       | Current recipe unavailable        | Researched ports; no managed runtime                                       | Upstream CUDA path researched; no qualified managed runtime |
| Optional portable Blender | Managed Windows x64 download and bounded operator checks                            | No managed download               | Existing-program probes do not qualify a workflow                          | Existing-program probes do not qualify a workflow           |

The recorded Windows AI configuration uses an RTX 3090. These measurements do not establish support
for every NVIDIA card, upstream mode or mesh. [Models and local runtimes](user/models.md) lists
exact catalog admission values and storage requirements; the
[platform research](../future/model-platform-spike.md) separates experimental ports from installed
model support.

Hardware inventory is advisory. A renderer's Metal adapter does not prove that a Python model
supports MPS; CUDA detection does not prove a particular model kernel supports that architecture.
Model admission uses the selected recipe's declared platform and measured configuration. Unmeasured
probes remain unknown rather than asserting CPU, Metal or CUDA readiness.

## What CI checks

[Source CI](../.github/workflows/ci.yml) runs formatting, lint, type checks and tests on hosted
Windows/macOS/Ubuntu runners. Its Linux lavapipe lane runs rendering, style, packing and export
checks on a software Vulkan adapter.

[Candidate builds](../.github/workflows/release.yml) create Windows, Linux, Intel Mac and Apple
Silicon CLI payloads plus a Windows NSIS installer. They execute copied CLI trees with an empty
`PATH`; Linux also exercises software rendering and all sprite exporters. These checks establish
build/payload behavior, not consumer-GPU performance or complete downloaded-model support.

The Windows preview's Vulkan payload excludes private Direct3D/DXC/FXC experiments. Broader release
qualification still needs native installed-app runs, clean-machine prerequisites, upgrade/uninstall
recovery, accessibility, signing/notarization and complete native notices. See the
[release checklist](developer/releases.md).

## When support needs rechecking

- Runtime, codec, renderer, shader or animation changes: repeat affected structural/image and
  installed-app checks using fresh caches.
- A new GPU, architecture or operating system: run the actual workload and record the adapter,
  driver, source version and limits. An emulated x64 run is separate from native ARM evidence.
- A new model or dependency recipe: repeat setup, native admission, inference and recovery checks.
- Driver changes without an exposed identity change: use a cold render cache.

The [renderer proof](../future/renderer-qualification.md),
[Node cutover](../future/runtime-cutover.md) and
[model provisioning record](../future/model-provisioning-gate.md) retain dated Windows evidence.
Historical results apply to their recorded source, machine and recipe.
