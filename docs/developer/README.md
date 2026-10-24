# Developing SpriteBook

The TypeScript/Node core owns project behavior and the command-line interface. Tauri/React Studio
calls that same core. A Python sidecar runs upstream models in separate, pinned environments.

| Area                                    | Documentation                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Set up, run and test a checkout         | [Development](development.md)                                                                               |
| Contribute a change                     | [Contributing](../../CONTRIBUTING.md)                                                                       |
| Understand module and process ownership | [Architecture](architecture/architecture.md)                                                                |
| Change persisted data or undo           | [Workspace persistence](architecture/workspace-persistence.md), [schema index](architecture/data-models.ts) |
| Change model resolution or admission    | [Execution policy](architecture/execution-policy.md)                                                        |
| Change rigging or retargeted motion     | [Rigging boundaries](rigging.md)                                                                            |
| Change the editor's UI                  | [Design system](design/design-system.md), [Studio design notes](../../apps/studio/DESIGN.md)                |
| Add or translate interface text         | [Localization](localization.md)                                                                             |
| Add or upgrade dependencies             | [Bill of materials](dependencies.md)                                                                        |
| Change exporters                        | [Export validation](export-validation.md)                                                                   |
| Prepare a version or publish candidates | [Versioning](versioning.md), [release checklist](releases.md)                                               |
| Understand the intended product         | [Product requirements](product.md)                                                                          |

[`AGENTS.md`](../../AGENTS.md) records repository conventions. Source schemas and catalogs define
the current contracts; documentation examples should agree with them. Internal planning and raw
experiment output belong outside the application repository.
