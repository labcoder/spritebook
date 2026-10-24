# Model and pack execution policy

Core enforces the catalog contract at execution time. Execution refuses missing model files or
runtime setup; installation is an explicit `models install` / `models setup` operation. See
[model management](../../user/models.md) for the complete Windows recipes qualified during F4.

For a workspace `<root>/<character>`, core checks exactly `<root>/pins.json`. An explicit `--pins
<file>` overrides that discovery, including for standalone `prep` and file-based bakes. This is the
existing `ProjectPins` document: `models`, `packs` and `rendererVersion`. Discovery does not walk
arbitrary ancestors. A missing implicit file means an unmanaged workspace; a present but invalid
file or a missing explicit file is an error.

In a managed project every executed model/pack needs an exact pin. An explicit requested model
version must agree. A missing pinned install never falls forward to a newer one. Unmanaged jobs
retain the existing explicit-version or highest-installed behavior and record the actual model
version in their result receipt. Retexturing considers only backends allowed by project pins. Recipe
replay with `gen --more-like` defaults to the recorded backend version; explicit model or version
flags request a different choice. Picking, undoing or rendering accepted assets does not require the
generator to remain installed.

Before model loading, generation, retexturing, Track B rigging and image preparation check:

- The selected version exists in the catalog and its install receipt names that exact model/version.
- Required acceptance matches a SHA-256 fingerprint of the catalog's declared license metadata.
  Install records the fingerprint. Missing fingerprints on older gated receipts require explicit
  reinstallation with consent; accepted workspace assets remain available.
- The receipt's territory declaration satisfies the current exclusions, and the current machine
  satisfies the version's platform gate. Install-time hardware is not execution-time evidence.
- Every receipted file matches its streamed hash, size and catalog pin; every declared file is
  present. Receipt paths cannot traverse directories, and model/version paths are single segments.
- Effective parameters select a measured memory profile and fit the available budget. The existing
  cross-process VRAM lease covers inference and releases on cleanup. No second scheduler is added.

The fingerprint covers declared metadata, not the contents of a changing legal web page. These
checks do not establish rights for undeclared transitive components. F4 records the selected
TRELLIS.2, Pixal3D and UniRig recipes and their installed offline evidence; new recipes remain F3
work and clean-machine/distribution clearance remains F7 work. To update recorded consent or
territory, remove and reinstall that exact model version through `models`.

`ModelVersion.vramProfiles` maps an operation and parameter subset to an admission claim with
measurement evidence. If profiles are declared, an unmatched configuration refuses with
`vram-unqualified`. A model without profiles retains its single configured-path `minVramGb`.
Overlapping matches take the largest claim. The claim drives both preflight and the existing lease.
The catalog's historical `minVramGb` remains an install advisory when profiles exist.

TRELLIS.2 uses the repo's historical measurements: 512 generation claims 4 GiB with offloading or 18
GiB resident; offloaded cascade generation retains 12 GiB; offloaded 512/1024 retexture claims 4/8
GiB. These include documented headroom above measured peaks. Unmeasured combinations refuse. F1
validates selection and admission logic, not fresh neural inference, universal input bounds or new
hardware support. The UI's resident-mode suggestion now requires a matching catalog profile.

Pack execution checks the actual `pack.json` version against the project pin before retargeting or
GPU work, including preview and direct bake jobs. Existing pack license/provenance and personal
import rules remain intact. No new pack territory/platform restrictions are invented.

`ProjectPins.rendererVersion` remains reserved and unenforced. The actual Node/Dawn
`renderSignature()` owns cache versioning, composing renderer, runtime, codec, backend and exposed
adapter/driver identities. It does not reuse the legacy cache namespace. See
[versioning](../versioning.md). F4 preserved the character/BakeManifest formats and sidecar
protocol; runtime recipes and policy metadata are registry additions.
