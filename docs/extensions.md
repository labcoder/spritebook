# Extensions

Open **File > Manage extensions** (Ctrl+M). Models, optional tools and bundled content share one
manager. Installing a tool does not enable an automatic repair or change a character.

- **Models** retains one recommended build, historical versions, license/platform gates,
  download/setup progress and verify/remove actions. Existing `models` commands and project pins are
  unchanged. See [models and runtimes](models.md).
- **Tools** offers Blender as an optional external program. Choose an existing installation or
  download a private portable copy. No Blender executable, Python environment or weights are bundled
  in SpriteBook.
- **Content** lists the bundled animation pack and style presets. These ship with the app; they have
  no separate installation/removal operation. This is not a community plugin loader.

## Optional Blender

Blender 4.5.15 LTS portable has native Windows x64 operator and walk/jump trial evidence. The
standalone build runs reliably, but **the tested automated clothing correction still fails on real
characters**. It is an experimental tool, not an adopted deformation provider. Read the
[maintained-build trial](../future/maintained-blender-trial.md) and
[binding/clothing follow-up](../future/binding-clothing-followup.md).

**Use existing Blender** accepts a full executable path and offers bounded PATH/ordinary-location
discovery. Discovery does not execute programs. **Check and use Blender** runs a bounded background
version/operator probe with isolated configuration, extension and temporary directories, factory
startup, offline mode and automatic scripts disabled. Existing Blender 4.5 LTS patches can be
checked; only 4.5.15 Windows x64 has the recorded standalone trial. Settings, startup files and file
associations are left alone. **Forget installation** removes its SpriteBook registration, preserving
the user-owned program.

**Download portable Blender** requires license acceptance. The Windows x64 archive is about 399 MB,
expands to about 925 MB, and requires at least 1.46 GB free for staging/extraction including the
declared margin. Repair files, retained older copies, concurrent writes and filesystem allocation
overheads can need more. No GPU model is downloaded and no system installer runs. The official
archive size/hash and executable hash are catalog-pinned; extracted files receive an inventory
receipt. **Check Blender** verifies the recorded files and repeats the probe. **Downloaded copies**
can select or remove a managed version independently of the selected user installation.

```powershell
spritebook extensions list --json
spritebook extensions use blender --path "C:\Program Files\Blender Foundation\Blender 4.5\blender.exe" --accept-license
spritebook extensions install blender@4.5.15 --accept-license
spritebook extensions verify blender
spritebook extensions use blender@4.5.15 --accept-license
spritebook extensions rm blender               # forget external / remove selected managed copy
spritebook extensions rm blender@4.5.15        # remove only this managed copy
```

`install --from <archive.zip>` reuses an offline archive with the same hash checks.
`--tools-dir <dir>` overrides tool storage; it does not change model storage or project pins. Normal
storage is `tools/` beside the existing `models/` and `runtime/` directories in platform application
data. `tools/blender.json` records the explicit choice; `tools/blender/<version>/` owns the
downloaded program and receipt. Invalid selections never silently fall back to another installation.
Choose again or forget the invalid selection; managed directories require a valid ownership receipt
to remove. Failed installs leave the prior selection intact. On retry, the exclusive installer lock
allows cleanup of abandoned `.staging-*` directories carrying SpriteBook's matching ownership
marker. Unmarked directories, malformed ownership markers and junctions are preserved. Older
unmarked stages need explicit cleanup; they are never guessed to be disposable.

Managed downloads currently cover Windows x64. Existing-program checks on Mac/Linux/ARM do not
constitute native qualification. No RTX 3090 requirement applies to selecting Blender; resource and
quality requirements depend on the actual processing operation. Current diagnostics are snapshots,
not reservations or proof that an arbitrary mesh fits memory.

## Catalog and licensing boundary

[`tools.json`](../packages/registry/catalog/tools.json) records the external tool's release,
license/source URL, platform archive and storage pins. It contains no install scripts. The manager
reuses registry downloads, hashing, resource checks, native locks, CLI jobs and Studio cancellation;
tools and model Python environments keep their own receipts and ownership.

Blender is separately downloaded under GPL-3.0-or-later. Keep the distribution's license/notices and
provide the corresponding source link; Blender's Python integration scripts also need a
GPL-compatible license. The process boundary alone is not a license waiver. See
[Blender's license](https://www.blender.org/about/license/) and
[distribution FAQ](https://www.blender.org/support/faq/).

Community catalog entries, packs and presets are a later extension point. Executable plugins need
their own versioned capability/permission contract and review; installing a hash-verified program
does not sandbox it. No marketplace or arbitrary in-process plugin API ships here.
