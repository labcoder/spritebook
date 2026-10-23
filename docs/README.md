# Documentation map

SpriteBook keeps its TypeScript core/CLI and Tauri/React desktop. Node 24.22.0 and Dawn 0.6.2 run
the current render pipeline. F4 is complete within the recorded Windows x64 scope; F7 owns release
qualification. Read [platform support](platform-support.md) before treating a build or model port as
a supported native target.

| Need                                              | Start here                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Build, run and contribute                         | [Repository README](../README.md#development)                                                                                              |
| Bake an existing mesh                             | [Quickstart](quickstart.md)                                                                                                                |
| Use Studio's six stages                           | [User guide](guide.md)                                                                                                                     |
| Run or automate a capability                      | [CLI reference](cli.md)                                                                                                                    |
| Install or remove model dependencies              | [Models and local runtimes](models.md), [sidecar setup](../sidecar/README.md)                                                              |
| Manage optional tools and bundled content         | [Extensions](extensions.md)                                                                                                                |
| Understand product goals and performance budgets  | [Product requirements](prd.md)                                                                                                             |
| Understand process, module and storage boundaries | [Architecture](architecture/architecture.md)                                                                                               |
| Change persisted or wire data                     | [Source schemas](../packages/schema/mod.ts), [data-model index](architecture/data-models.ts)                                               |
| Change mutations, undo or process ownership       | [Workspace persistence](architecture/workspace-persistence.md)                                                                             |
| Change model/pack resolution or admission         | [Execution policy](architecture/execution-policy.md)                                                                                       |
| Change editor interactions or presentation        | [Design system](design/design-system.md)                                                                                                   |
| Add a dependency or prepare distribution          | [BOM](dependencies.md), [licensing](licensing.md), [versioning](versioning.md)                                                             |
| Validate engine output                            | [Export validation](export-validation.md), [engine guides](engines/godot.md)                                                               |
| Plan migration/release work or inspect evidence   | [Active roadmap](../future/roadmap.md), [cutover](../future/runtime-cutover.md), [model platform spike](../future/model-platform-spike.md) |

Usage and architecture pages describe the current implementation. The PRD and design system retain
the intended product journey, including later F3/F5/F6 improvements. Source schemas and catalogs
define exact shapes and available models; design examples do not install a model or establish
platform support. `future/` contains the approved plan, dated qualification records and research.
Historical measurements remain evidence for their recorded source, machine and recipe.

When behavior changes, update the affected guide with the code. Record binding decisions and session
progress in the local `docs/internal/` records as required by [AGENTS.md](../AGENTS.md).
