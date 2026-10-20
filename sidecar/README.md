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

**Existing model gate qualified:** the selected TRELLIS.2 runtime replaces evaluation-only NVIDIA
components with DRTK and a traced O-Voxel build, retaining complete notices. Fresh installed
provisioning and offline TRELLIS.2/UniRig generation-to-sprite workflows pass on Windows x64/RTX
3090. The `af44b45f.local1` catalog version includes the exact DINOv3 config, weights and agreement;
access remains manually gated and installation requires explicit acceptance. Decoder/conditioner
loading is local-only. F4 is extended for Pixal3D integration and a platform/model spike; their
qualification is separate from the completed incumbent proof. See the
[F4 model gate record](../future/model-provisioning-gate.md) for the exact artifacts, local
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
`pixal3d` (`gen3d`) — official single-view PBR generation in its isolated environment; `trellis2`
(`gen3d`) and `trellis2-retexture` (`retexture`) — the real backend, which needs the optional stack
below; `texture-substage` (`imageprep`); and `unirig` (`rig`). `GET /handshake` is always the
authoritative list.

Pose heuristic v1 constants (documented in `spritebook_sidecar/adapters/pose_check.py`): arm band
rows `[0.20, 0.45)` of the alpha bbox height, torso band `[0.45, 0.70)`, spread ratio `1.35` (widest
arm-band row extent vs median torso-band row extent), coverage ok range `[5%, 95%]`, minimum short
side `512 px`.

## Pinned versions (uv-resolved 2026-07-19, exact `==` pins in `pyproject.toml`)

| package     | version                        |
| ----------- | ------------------------------ |
| Python      | 3.11.16 (`.python-version`)    |
| rembg       | 2.0.77 (no `cli`/`gpu` extras) |
| onnxruntime | 1.27.0 (CPU build)             |
| numpy       | 2.4.6                          |
| pillow      | 12.3.0                         |

`uv.lock` is committed. `[tool.uv] constraint-dependencies = ["numba>=0.60"]` pins rembg's
transitive `pymatting → numba` edge to a wheel-bearing release: without the floor, the resolver
walks numba back to 0.53.x, a 3.6–3.9-era sdist that cannot build on 3.11 (and source builds violate
the sidecar-vram "prebuilt wheels only" law). The HTTP server itself is Python stdlib only — no
FastAPI/uvicorn/requests.

## Optional model setup on Windows x64 + NVIDIA CUDA

Use the CLI to provision backend code and dependencies as well as weights:

```sh
spritebook models install trellis2-4b --accept-license
spritebook models setup trellis2-4b --accept-license  # repair/reuse existing weights
spritebook models install unirig
spritebook models setup unirig
spritebook models install pixal3d --accept-license
spritebook models setup pixal3d --accept-license
```

TRELLIS.2 uses the optional `trellis2` group in the committed `uv.lock`: Torch 2.8.0+cu128,
torchvision 0.23.0, xformers 0.0.32.post2 and transformers 5.14.1. The base sidecar remains usable
without this group. Python is pinned to 3.11.16; the CUDA wheels require cp311. Linux, Mac and
Windows ARM64 native model setup remain unqualified and are deferred to F7.

Pixal3D uses a separate [frozen environment](runtimes/pixal3d/pyproject.toml) and
[source/native recipe](runtimes/pixal3d-win.json): Torch 2.8/cu128, Transformers 4.57.3, NATTEN
0.21.6, actual NAF and the existing permitted DRTK export boundary. Setup exercises native SM86
attention, NAF and mesh/PBR kernels before readiness. The initial recipe is single-view 1024 cascade
with stage offload, 12 steps and an explicit horizontal `fov=0.2` radians. The camera value and
strict NAF use are recorded in generation metadata. It requires a nonempty cut-out RGBA image and
its declared local DINOv3/NAF files. No MoGe, BRIA, multiview or Pixal retexture capability is
implied. Full generation/hardware qualification is recorded separately in F4-T6/T7.

The [runtime recipe](runtimes/trellis2-win.json) pins source archives, sizes, SHA-256 hashes,
notices and a bounded source patch. Setup uses the owned uv and prebuilt third-party wheels; no Git,
MSVC or local CUDA toolkit is needed. It publishes a readiness receipt in writable app data after
native kernel checks. Core reads that receipt and supplies absolute source/environment paths. A
failed setup retains verified weights; rerun `models setup` to recover.

UV rasterization uses MIT DRTK instead of NVIDIA's evaluation-only nvdiffrast. The O-Voxel
replacement has traced MIT source and Eigen MPL-2.0 notices. These packages remain external
downloads, excluded from application resources. Both real generation and retexture have passed with
the restricted packages absent, an empty HF cache and outbound connections blocked; final installed
workflow qualification is tracked in [the F4 gate](../future/model-provisioning-gate.md).

DINOv3 access remains personal: request access on its Hugging Face page, then `hf auth login`. The
complete `af44b45f.local1` catalog version declares its exact config, weights and August 19, 2025
agreement. `--accept-license` records explicit acceptance. The pinned agreement has custom use/trade
and redistribution terms; consult that exact text. The loader uses only the declared local files and
refuses upstream's BRIA background remover and Hub fallback.

Developer overrides `SPRITEBOOK_TRELLIS2_CODE` and `SPRITEBOOK_UTILS3D_CODE` remain available for
prepared source trees. They are unnecessary for ordinary installs. The original source's
visualization/training helpers are outside the supported inference path and may still reference
dependencies we deliberately omit.

UniRig uses a [separate frozen recipe](runtimes/unirig-win.json), Torch 2.7+cu128 and NumPy 1.26.4.
Its app-owned architecture description preserves active model settings without downloading the
restricted Meta OPT config. Keep the PTv3 standard-attention workaround and 17.4 GiB admission
floor. GPL components stay in the external subprocess environment.

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
