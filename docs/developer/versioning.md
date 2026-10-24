# Version identities

SpriteBook versions the product, rendered pixels, documents and external model/runtime recipes
separately. A release checklist belongs in [Preparing a release](releases.md).

| Identity             | Source of truth                                         | Changes when…                                            |
| -------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Product version      | `packages/cli/version.ts`, root/Studio/Tauri metadata   | A user-facing version is prepared                        |
| Render pipeline      | `RENDERER_VERSION` in `packages/render/contracts.ts`    | A change can affect rendered pixels or atlas layout      |
| Render signature     | `renderSignature()` in `packages/render/diagnostics.ts` | Pipeline/runtime/backend/adapter identity changes        |
| Document schema      | Validators and migrations in `packages/schema`          | Persisted or wire shapes change                          |
| Model/runtime recipe | Registry catalog, hashes and frozen runtime recipes     | Files, parameters, terms or prepared dependencies change |

## Product versions

The product uses pre-1.0 semantic versions. Breaking CLI or manifest changes require a minor bump;
fixes and compatible additions can use a patch. A deliberately scoped feature release may also
advance the minor version. Keep the CLI, root/Studio package metadata and Tauri Cargo/config
versions in sync; the candidate workflow compares version tags to the CLI value.

Use annotated tags named `v<version>` from a reviewed commit on `main`. Prerelease labels may use
suffixes such as `-alpha.1`, and GitHub preview releases should remain marked prerelease. Earlier
prototype changelog numbers remain historical; they do not establish installer-upgrade
compatibility.

## Render versions and cache identity

Bump `RENDERER_VERSION` for pixel-affecting changes in shaders, camera framing, animation sampling,
AOV encoding, style algorithms or packing. A product-only version change does not require a render
bump. An unchanged render version after a pixel change can serve stale cached frames.

The bake signature composes that version with a short SHA-256 identity:

```text
<RENDERER_VERSION>#<8-hex runtime/backend/adapter hash>
```

It includes Node/platform/architecture, Dawn, PNG/zlib identity, backend and exposed adapter fields.
The bake records it as `inputs.rendererVersion`; `doctor` prints it. Some drivers expose less
identity than others, so use a fresh cache after a driver-only change with no visible identity
change.

`ProjectPins.rendererVersion` remains reserved and unenforced; it does not select a render
executable. The actual render signature owns cache identity.

## Golden images

Style fixtures live under `packages/style/fixtures/goldens/`; the packer also has a placement
golden. Regenerate them with:

```sh
npm run goldens:update
```

Review the images and explain why the output changed. Include the pipeline change, render-version
bump and golden refresh together. Keep exact structural assertions separate from tolerant hardware
image comparisons. Do not loosen assertions or retry image failures to make a suite pass. See the
[renderer testing skill](../../.agents/skills/renderer-golden-testing/SKILL.md) for the full policy.

## Documents and external recipes

Use each schema's version gate and migration rather than one global document version.
[The source contract index](architecture/data-models.ts) maps current definitions. Preserve previous
accepted assets through migrations and test with disposable project copies.

Catalog model versions, file hashes, consent fingerprints and prepared-runtime identities are
independent of product tags. A model update must not silently change an existing project pin. See
[execution policy](architecture/execution-policy.md).
