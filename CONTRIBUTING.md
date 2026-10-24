# Contributing

Start with the [development guide](docs/developer/development.md). For a bug report, include the app
version, operating system, selected model/runtime version, steps to reproduce and the relevant
session-log error. Remove tokens and personal paths before posting logs; share character assets only
when you have permission.

Keep changes focused. Put durable behavior in the TypeScript core and expose it through the CLI
before adding a Studio control. Preserve the original input and last usable asset when a job fails.
Use the existing architecture, controls and dependencies where they fit.

Add tests for behavior that can regress: file ownership, persistence, parsing, cancellation and
recovery deserve particular care. Test through the public operation rather than asserting private
call order or repeating implementation constants. Review image changes as images, with a stated
reason; keep deterministic and hardware-specific checks separate.

Before submitting:

```sh
npm run fmt:check
npm run lint
npm run check
npm test
```

Run the smaller relevant checks during development. Use the full suite before submitting a broad
change; GPU, model and engine lanes have explicit prerequisites in the
[development guide](docs/developer/development.md#checks).

Update the affected docs with behavior changes. Add dependency role, pin and license information to
the [bill of materials](docs/developer/dependencies.md) in the same change. Use
[Conventional Commits](https://www.conventionalcommits.org/), such as `fix(rig): preserve the
previous mesh on failure`. Pull requests should explain the problem, resulting behavior and
validation.

The [architecture](docs/developer/architecture/architecture.md),
[design system](docs/developer/design/design-system.md) and [license](LICENSE) apply to
contributions.
