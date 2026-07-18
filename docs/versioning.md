# Versioning & releases

How SpriteBook versions the product, the render pipeline, and the golden sets — and how the three
move together.

## Product versioning

Semver, pre-1.0. Releases are `0.x.y` with alpha pre-release numbers (`0.1.0-alpha.1`,
`0.1.0-alpha.2`, ...). The single source of the product version is `SPRITEBOOK_VERSION` in
`packages/cli/version.ts`; `spritebook --version` prints it.

Pre-1.0 rules:

- Breaking changes to the CLI surface or to manifest formats bump the **minor** version.
- Fixes and additive changes advance the patch / alpha number.
- Tags are annotated, named `v<version>` (`v0.1.0-alpha.1`), and cut from `main`.

## rendererVersion and the render signature (D-023)

The render package owns the pipeline version: `RENDERER_VERSION` in `packages/render/contracts.ts`,
currently `spritebook-render@0.1.0`.

**Bump it on any pixel-affecting change anywhere in the bake pipeline** — shaders, camera framing,
the pose driver, AOV encoding, style algorithms, packing — not only changes inside the render
package. The string anchors every cache key and every golden set; an unbumped pixel change means
warm caches serve stale pixels and golden diffs lie about their cause.

Cache keys never carry the raw string. At bake time they carry `renderSignature()`
(`packages/render/diagnostics.ts`):

```
<RENDERER_VERSION>#<8-hex sha256 of the adapter info>
e.g. spritebook-render@0.1.0#a1b2c3d4
```

Composing the adapter-identity hash in means a GPU or driver change flips every cache key — a
deliberate, honest full miss, because pixels are only deterministic per (pipeline version, adapter,
driver). The signature is recorded verbatim in every `BakeManifest` (`inputs.rendererVersion`) for
provenance, and `spritebook doctor` prints it.

## Golden-refresh workflow

Goldens live in `packages/style/fixtures/goldens/` (per-preset perceptual goldens over committed AOV
fixtures) plus the exact packer placement golden in `packages/pack/maxrects_test.ts` (the D-022
layout tripwire). The style goldens are byte-reproducible on any machine — the style stage is pure
deterministic CPU.

Regenerate only via the generator:

```
deno run --allow-read --allow-write --allow-env --allow-ffi \
  packages/style/fixtures/_gen-goldens.ts
```

Rules (mirroring the `renderer-golden-testing` skill — keep the two consistent):

- A golden change ships **in the same commit** as the pixel-affecting change and a
  `RENDERER_VERSION` bump, with a commit message that says **why** pixels changed.
- Golden diffs are reviewed **as images**, never as byte counts.
- A golden change without a pipeline change is a bug report, not an update.
- Never loosen an assertion or add retries to make an image test green.

## Code signing

Deferred to the 1.0 desktop bundle (maintainer decision). Alpha binaries are **unsigned**;
[quickstart.md](quickstart.md) documents the per-OS first-run steps (SmartScreen, Gatekeeper,
`chmod`). The signing/notarization investment lands once, on the Tauri desktop app — Tauri's bundler
signs the bundled CLI sidecar in the same pipeline, so signing the bare alpha binaries separately
would pay that cost twice.

## Distribution

- **GitHub Releases** host the alpha artifacts (the repo is private; releases serve the maintainer
  and invited testers): one zip per target — `win-x64`, `mac-arm64`, `mac-x64`, `linux-x64` — each
  containing the binary, a sample model, and the quickstart. Eventual public distribution stays
  itch.io / the maintainer's website per D-017.
- **win-arm64** has no native `deno compile` target; use the win-x64 zip — Windows-on-ARM runs it
  under x64 emulation ([platform-support.md](platform-support.md)).
- **npm** (a binary-launcher shim around the same binaries) is planned immediately after the alpha
  per the D-017 reservation trigger; it is not part of this tag.

Outputs are never distribution-encumbered: assets baked with SpriteBook are exempt from the AGPL via
the output exception in `NOTICE`.
