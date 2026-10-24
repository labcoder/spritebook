# SpriteBook documentation

SpriteBook has two documentation paths:

| You want to…                                | Start here                                     |
| ------------------------------------------- | ---------------------------------------------- |
| Make a character and export sprites         | [User documentation](user/README.md)           |
| Build, extend or contribute to SpriteBook   | [Developer documentation](developer/README.md) |
| Check operating system and hardware support | [Platform support](platform-support.md)        |
| Understand code, model and output terms     | [Licensing](licensing.md)                      |

The application uses a TypeScript core on Node, a Python model sidecar and Tauri/React Studio. The
[architecture guide](developer/architecture/architecture.md) explains those boundaries;
[`packages/schema`](../packages/schema/mod.ts) defines persisted and wire data.

User guides describe current behavior. The [product requirements](developer/product.md) also
describe future goals; they do not establish hardware support. Historical research in `future/`
records its source version and measurement scope.

Keep public usage and technical documentation in this repository. Keep private plans, experiment
outputs and qualification reports in the separate management workspace. The ignored `docs/internal/`
directory contains legacy local records and is not part of the public documentation.
