# spritebook-sidecar

Local Python sidecar for SpriteBook (P3-T2). One per session, owned by core, localhost only. The
wire contract is FROZEN in `packages/schema/sidecar.ts` (contractVersion **1**); NDJSON job events
use the `packages/schema/jobs.ts` vocabulary with strict shapes — no extra fields, ever.

## Installed candidates

The Node launcher provides an absolute owned uv path. Core uses `uv run --frozen --no-editable`
against the shipped Python source, with a lock-specific `sidecar-<hash>` environment under the
platform's writable `spritebook/runtime/` data directory. Windows uses `%LOCALAPPDATA%`; Mac uses
`~/Library/Application Support`; Linux uses `$XDG_DATA_HOME` or `~/.local/share`.
`UV_PROJECT_ENVIRONMENT` remains an explicit override. Python bytecode is disabled for immutable
installed resources. Normal wheel installation avoids Python 3.11's locale-decoded editable `.pth`
paths, which break when the application path contains Unicode on Windows. Source development keeps
uv's editable default. No virtual environment or weights are copied from the builder.

F4's fresh-profile base sync, handshake and shutdown pass with an empty PATH; real
registry-installed U2-Net prep also passes. This does **not** install optional CUDA backends. For
the incumbent adapters, set absolute paths outside the checkout:

- `SPRITEBOOK_TRELLIS2_CODE`: an explicitly prepared TRELLIS.2 source directory; its optional
  dependencies still require the verified wheel procedure below.
- `SPRITEBOOK_UNIRIG_HOME` and `SPRITEBOOK_UNIRIG_PYTHON`: a prepared UniRig source tree and its
  separate Python interpreter. The legacy source defaults under retired spikes are not an installed
  runtime recipe. Missing prerequisites refuse with `backend-missing` before inference.
- Authenticate gated Hub access using `hf auth login` or `HF_TOKEN`. The Node downloader also reads
  `HF_TOKEN_PATH` / `$HF_HOME/token`, sends credentials only to HTTPS huggingface.co and strips them
  at CDN redirects. It never records token values. See the
  [Hub environment contract](https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables).

**Open model gate:** the existing TRELLIS.2 CUDA stack has evaluation-only NVIDIA components and an
unverified O-Voxel wheel provenance/notice gap listed in the BOM. DINOv3 remains manually gated and
absent from its registry file set; upstream may fetch it after authentication. Fully declared
fresh/offline generation and UniRig environment provisioning are not established by the Node port.
They remain explicit roadmap gates, rather than an implicit dependency on an old HF cache or a
builder's deleted environment. See the
[F4 model gate investigation](../future/model-provisioning-gate.md) for the exact artifacts, local
dependency resolution defects, frozen setup requirements and closure checks.

## How core launches it

```
SPRITEBOOK_SIDECAR_TOKEN=<per-session token>  uv run --frozen --project sidecar spritebook-sidecar --port 0
```

- The token travels in the **`SPRITEBOOK_SIDECAR_TOKEN`** env var (never argv). Missing/empty token
  → the process exits nonzero with a stderr message.
- `--port 0` (default) binds an ephemeral port; the sidecar binds **127.0.0.1 only**, never 0.0.0.0.
- On start the sidecar prints **exactly one stdout line** and then never writes stdout again (stdout
  is repointed at stderr after the line):

  ```json
  { "t": "listening", "port": 56388, "pid": 13872 }
  ```

  Core reads that line to learn the bound port. All logging goes to stderr.

### Endpoints (all require `Authorization: Bearer <token>`; else 401)

| Route            | Behavior                                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /handshake` | 200 `SidecarHandshake` JSON: contractVersion, sidecarVersion, python, adapter roster                                                                                                                                                                                             |
| `POST /jobs`     | 200 `application/x-ndjson` chunked; one JobEvent per line, flushed as produced; always ends `done` or `error`, then the connection closes. One job at a time — a concurrent POST gets 409 `job-already-running`. Unknown adapter id → `queued` then `error` (`unknown-adapter`). |
| `POST /shutdown` | 202, then graceful process exit (response finishes first)                                                                                                                                                                                                                        |
| anything else    | 404 JSON                                                                                                                                                                                                                                                                         |

## Adapter roster

| id           | kind        | version | params (required)                                                  | emits                                                                                                                                                                                                                                                                           |
| ------------ | ----------- | ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `echo`       | `test`      | 1.0.0   | `steps`, `delayMs`, `outDir` (+ optional `failAt`)                 | progress `echo` ×steps; artifact `echo-log` (`<outDir>/echo.txt`); `failAt` → error `echo-fail`. Kill-target for core's death test.                                                                                                                                             |
| `rembg`      | `imageprep` | 2.0.77  | `imagePath`, `outDir`, `modelDir` (+ optional `model` ∈ {`u2net`}) | progress `load`/`infer`/`encode`; artifact `cutout` (`<outDir>/cutout.png`, RGBA); artifact `preflight` (`<outDir>/preflight.json`); warn `cutout-noop` when alpha is all-opaque; error `empty-cutout` when alpha is all-zero; error `model-missing` when the weight is absent. |
| `pose-check` | `imageprep` | 1.0.0   | `imagePath` (an RGBA cutout), `outDir`                             | progress `analyze`; artifact `preflight` (`<outDir>/preflight.json`) — the same pose heuristic v1, standalone.                                                                                                                                                                  |

The rest of the roster, in announcement order after those three: `fixture-gen` (`gen3d`) and
`fixture-retexture` (`retexture`) — deterministic, weightless stand-ins the test suite runs on;
`trellis2` (`gen3d`) and `trellis2-retexture` (`retexture`) — the real backend, which needs the
optional stack below; `texture-substage` (`imageprep`); and `unirig` (`rig`). `GET /handshake` is
always the authoritative list.

Pose heuristic v1 constants (documented in `spritebook_sidecar/adapters/pose_check.py`): arm band
rows `[0.20, 0.45)` of the alpha bbox height, torso band `[0.45, 0.70)`, spread ratio `1.35` (widest
arm-band row extent vs median torso-band row extent), coverage ok range `[5%, 95%]`, minimum short
side `512 px`.

## Pinned versions (uv-resolved 2026-07-19, exact `==` pins in `pyproject.toml`)

| package     | version                                   |
| ----------- | ----------------------------------------- |
| Python      | 3.11 (`.python-version`; runs on 3.11.15) |
| rembg       | 2.0.77 (no `cli`/`gpu` extras)            |
| onnxruntime | 1.27.0 (CPU build)                        |
| numpy       | 2.4.6                                     |
| pillow      | 12.3.0                                    |

`uv.lock` is committed. `[tool.uv] constraint-dependencies = ["numba>=0.60"]` pins rembg's
transitive `pymatting → numba` edge to a wheel-bearing release: without the floor, the resolver
walks numba back to 0.53.x, a 3.6–3.9-era sdist that cannot build on 3.11 (and source builds violate
the sidecar-vram "prebuilt wheels only" law). The HTTP server itself is Python stdlib only — no
FastAPI/uvicorn/requests.

## The `trellis2` extra (optional, ~4 GB, Windows + CUDA)

The TRELLIS.2 image-to-3D stack is an **optional dependency group**, so a machine with no GPU
installs the base project and still gets a fully working sidecar — every adapter except `trellis2`
and `trellis2-retexture`, including the `fixture-*` pair the whole test suite runs on. That is
verified, not assumed: a base-only sync passes all self-test checks with no torch installed.

```
python sidecar/fetch_wheels.py                  # fetch missing wheels and verify the pins
python sidecar/fetch_wheels.py --verify         # verify only, never download
uv sync --project sidecar --extra trellis2
```

Verify the wheels first and mean it. The five CUDA extensions (`cumesh`, `flex_gemm`, `nvdiffrast`,
`nvdiffrec_render`, `o_voxel`) are community builds by a single maintainer, fetched from a
`raw.githubusercontent` URL that can move at any time. They are vendored under `sidecar/wheels/` and
pinned by sha256 in `wheels.lock.json`; `uv` installs them from those verified bytes by path.

Two more things this stack needs, neither of which `uv` can supply:

- **The `trellis2` package itself has no packaging metadata upstream** — it is imported from a
  source checkout, not installed. Clone it and point the adapter at it: `git clone --depth 1
  https://github.com/microsoft/TRELLIS.2.git sidecar/.deps/trellis2`, or set
  `SPRITEBOOK_TRELLIS2_CODE` to wherever it lives.
- **DINOv3 is a manual gate.** `facebook/dinov3-vitl16-pretrain-lvd1689m` is the image conditioner
  and access is granted per person by Meta, so it cannot be installed through the registry. Request
  it on the model's page, then `hf auth login`. Meta's licence permits commercial use and
  redistribution; the price is an attribution — **"Built with DINOv3"** must appear in the product's
  UI, docs or about page.

Pins are the combination measured in the retired TRELLIS.2 spike (available in Git history), not the
newest compatible set: torch 2.8.0+cu128, torchvision 0.23.0, xformers 0.0.32.post2, transformers
5.14.1. `xformers` is not optional — sparse attention supports only xformers and flash-attn, and
flash-attn needs a compiler. `transformers` is pinned because 5.x moved the DINOv3 encoder blocks
and the adapter shims the move; an unpinned upgrade would walk away from the shim silently.

`requires-python` is `>=3.11,<3.12` because of this extra: the extension wheels are cp311-only and
`uv` solves the lock across the whole declared range.

## rembg model-path mechanism (verified against the pinned 2.0.77 source)

In rembg 2.0.77, `BaseSession.__init__` resolves the model file by calling
`cls.download_models(...)`, and `U2netSession.download_models` calls `pooch.retrieve(<github url>,
md5, path=U2NET_HOME)` — pooch **downloads** whenever the file is missing or its hash mismatches, so
the `U2NET_HOME` env var alone cannot guarantee offline behavior.

The adapter therefore never uses `new_session()`/`U2NET_HOME`. It:

1. verifies `<modelDir>/u2net.onnx` exists **before importing rembg or loading anything** — if
   absent it raises `AdapterError('model-missing', …)` naming the exact expected path and the fix
   (`spritebook models install rembg-u2net`);
2. constructs a `U2netSession` subclass whose `download_models` override returns that verified local
   path (`BaseSession.__init__` forwards its kwargs to `download_models`, so the path rides in as
   `model_path=`). pooch is never invoked on any code path — the network is unreachable by
   construction.

Output validation (sidecar-vram law): the cutout's alpha plane is checked numerically — all-zero
alpha → `empty-cutout` error; all-255 alpha → `cutout-noop` warn; the alpha>0 coverage fraction
feeds the preflight `cutout` check.

## Self-test

```
uv run --project sidecar python -m spritebook_sidecar.selftest
```

Runs the real server on an ephemeral port and covers auth (401), handshake shape, echo end-to-end
over real HTTP (exact event sequences, strict key sets, artifact on disk), the `failAt` error path,
unknown adapter, 409 single-flight, the pose heuristic on synthetic silhouettes, the rembg
`model-missing` fast-fail (no network, no weight needed), and `/shutdown`. Prints one `PASS … checks
OK` line and exits nonzero on failure. No pytest — stdlib assert + tempfile.
