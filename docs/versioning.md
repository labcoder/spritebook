# Versioning & releases

This page is for contributors working in the repository. The release zips do not include the
repository, and the commands here assume a checkout.

How SpriteBook versions the product, the render pipeline, and the golden sets — and how the three
move together.

## Product versioning

Semver, pre-1.0; the current product version is `0.9.0`. Prerelease tags may use suffixes such as
`-alpha.1`. The CLI version is `SPRITEBOOK_VERSION` in `packages/cli/version.ts`; `spritebook
--version` prints it. Keep root/Studio package metadata and Tauri's version in sync when advancing
the product version; the candidate workflow checks the tag against the CLI value.

Pre-1.0 rules:

- Breaking changes to the CLI surface or to manifest formats bump the **minor** version.
- Fixes and additive changes advance the patch / alpha number.
- Tags are annotated, named `v<version>` (`v0.1.0-alpha.1`), and cut from `main`.

## rendererVersion and the render signature (D-023)

The render package owns the pipeline version: `RENDERER_VERSION` in `packages/render/contracts.ts`,
currently `spritebook-render@0.6.0`. It moves on its own schedule: it tracks PIXELS, not the
product, so a product release never bumps it and a pixel change always does. The 0.9.0 product
version and the 0.6.0 render version are both correct and unrelated.

**Bump it on any pixel-affecting change anywhere in the bake pipeline** — shaders, camera framing,
the pose driver, AOV encoding, style algorithms, packing — not only changes inside the render
package. The string anchors every cache key and every golden set; an unbumped pixel change means
warm caches serve stale pixels and golden diffs lie about their cause.

Cache keys never carry the raw string. At bake time they carry `renderSignature()`
(`packages/render/diagnostics.ts`):

```
<RENDERER_VERSION>#<8-hex sha256 of runtime/backend/adapter identity>
e.g. spritebook-render@0.6.0#9a231c45
```

The signature includes Node version, platform/architecture, Dawn version, PNG/zlib identity, backend
and every exposed adapter field. The qualified NVIDIA Vulkan path exposes its driver version in the
adapter description. Other platforms may expose less: diagnostics retain what is available, and
driver-only updates without an exposed change still require a cold bake. The signature is recorded
in every BakeManifest (`inputs.rendererVersion`) and printed by `doctor`. The F4 namespace does not
reuse Deno-rendered cache entries; old bakes/exports remain readable.

`ProjectPins.rendererVersion` is currently a reserved, unenforced field; it does not select or
freeze the render executable. The actual signature above owns cache identity. CharacterManifest has
its own schema version, currently 3; Project, BakeManifest and AnimPack remain at 2. Other schemas
version independently. See [the source contract index](architecture/data-models.ts) and
[`packages/schema/migrate.ts`](../packages/schema/migrate.ts). Product, renderer, document and
model/runtime recipe versions are separate identities.

## Golden-refresh workflow

Goldens live in `packages/style/fixtures/goldens/` (per-preset perceptual goldens over committed AOV
fixtures) plus the exact packer placement golden in `packages/pack/maxrects_test.ts` (the D-022
layout tripwire). The style goldens are byte-reproducible on any machine — the style stage is pure
deterministic CPU.

Regenerate only via the generator:

```
npm run goldens:update
```

Rules (mirroring the `renderer-golden-testing` skill — keep the two consistent):

- A golden change ships **in the same commit** as the pixel-affecting change and a
  `RENDERER_VERSION` bump, with a commit message that says **why** pixels changed.
- Golden diffs are reviewed **as images**, never as byte counts.
- A golden change without a pipeline change is a bug report, not an update.
- Never loosen an assertion or add retries to make an image test green.

## Code signing and distribution

F7 owns signing/notarization and native notice clearance. Windows runtime packaging merges a UTF-8
process code page into an app-owned Node copy so Dawn can load from Unicode paths. This changes
upstream executable signing; sign the final owned binaries afterward. No system executable or locale
is modified.

The release workflow builds **candidate artifacts** with a complete owned runtime, sample, docs and
notices, and a Windows NSIS candidate. It executes copied CLI trees on native hosted OS runners;
Linux additionally exercises software Vulkan. This is not a public release or native GPU/desktop
qualification. Windows ARM64, both Mac architectures and Linux remain F7 targets, including native
execution, installer recovery and accessibility checks. No emulated run counts as native evidence.

Keep the entire portable runtime tree together. It includes production JavaScript dependencies and
native assets, with no development node_modules, compiler or source TypeScript. The installed app
uses the same core. Weights and Python/CUDA environments are separate, gated installs. Eventual
public distribution remains itch.io / the maintainer's website per D-017; no npm launcher is added
by the runtime migration.

SpriteBook's output exception in `NOTICE` means generating an asset does not subject it to the
application's AGPL. Model and imported asset terms still apply; see [licensing](licensing.md).
