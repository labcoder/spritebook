---
name: sidecar-vram
description: Running AI model stages (rigging, generation, segmentation) through the Python sidecar - VRAM budgeting and preflight, silent-GPU-failure validation, bpy subprocess discipline, checkpoint trust, and wall-time realities. Use this skill whenever implementing or modifying the sidecar service, a model adapter, registry VRAM/platform gates, or when a model stage "succeeds" but its output is garbage. Every rule was measured or bled for in P0-T4 (UniRig on native Windows); the failure classes here are silent by default and only these disciplines make them loud.
---

# The sidecar: VRAM, validation, and process discipline

P0-T4 ran UniRig end-to-end on native Windows (RTX 3090). The pipeline "worked" long before it was
RIGHT: a CUDA kernel fault produced 100% NaN outputs with exit code 0, and bpy stages crashed after
finishing their work. This skill is the discipline that separates ran from correct.

## VRAM: measure, never trust docs

- Registry `min_vram` comes from MEASURED peaks, not README claims. UniRig's measured floor at 50k
  faces: **10.0 GiB** (flash-attention path) / **17.4 GiB** (standard-attention workaround) — a
  single config flag moved the budget by 7.4 GiB. Config choices are part of the VRAM contract.
- Sample VRAM during every adapter run (the P0-T4 pattern: a background sampler writing CSV; peaks
  recorded per stage) and write the peak into job provenance. Budgets drift with mesh size, batch
  size, and upstream versions — provenance catches the drift.
- **Preflight before the job starts** (D-009 gate): detected VRAM vs the catalog entry's `min_vram`
  for the CONFIGURED path. Fail before loading weights, with an honest message — not an OOM twenty
  seconds in.
- Disk is a budget too: UniRig checkpoints 5.8 GB + env ~9 GB. Registry install sizes are real
  numbers users see; record them in catalog entries.

## Silent GPU failure is the default failure

- **A kernel can fault and the stage still exits 0 with garbage output.** The P0-T4 find: flash-attn
  2.8.3's varlen kernel on Windows sm_86 committed an illegal memory access inside PTv3 → **all-NaN
  skin weights under bf16 (completely silent)**, hard CUDA fault under fp32. Diagnosed by NaN-census
  of the output npz, `CUDA_LAUNCH_BLOCKING=1`, and per-component exoneration probes — not by any
  exit code.
- Therefore: **adapters validate model outputs numerically, always.** NaN/Inf census, weight row-sum
  checks, range sanity per output type. An adapter without output validation is not done.
  (Downstream symptoms mislead: the visible "divide" warning and Blender's `neutral_bone` were
  echoes two stages removed from the real fault.)
- Platform-specific kernel flags (e.g. `enable_flash`) are per-platform adapter CONFIG with a
  recorded cost/benefit (here: correctness on Windows for +7.4 GiB). Keep upstream patches minimal,
  marked, and listed in the adapter's provenance.
- Tier-1 auto-repair candidate: on failed output validation, retry once with a different seed before
  surfacing the error.

## Process discipline

- **bpy stages crash at interpreter teardown AFTER completing their work** (0xC0000005 on Windows,
  routinely). Run every bpy step in a disposable subprocess and validate EXPECTED ARTIFACTS (files
  exist, parse, pass output validation) instead of trusting exit codes. This is general sidecar law:
  artifact validation over exit codes for any stage embedding a complex runtime.
- Model loads dominate wall time: UniRig measured ≈75–85 s/mesh end-to-end of which inference was
  ≈8–16 s — the rest is loads and CPU stages. Keep models RESIDENT across a batch (the sidecar
  session owns the loaded model); per-mesh cold starts pay the load every time. Batching amortizes;
  the ≤30-min image→engine budget depends on it.
- The sidecar contract (P3-T2): localhost HTTP, per-session token, version handshake, NDJSON job
  streaming mapped 1:1 onto core's JobEvent vocabulary. Kill-mid-job must surface a RETRYABLE error
  in core and recover on retry — design for the sidecar dying, because it will.

## Checkpoints and environments

- torch ≥2.6's safe unpickler rejects checkpoints with embedded objects (UniRig's skin checkpoint
  embeds `box.Box`). Loading with `weights_only=False` is acceptable ONLY for checkpoints whose
  hashes the registry has pinned and verified (D-009) — the trust anchor is the hash, never the
  download source.
- Environments are uv-managed with PREBUILT wheels only, exactly matched to torch+CUDA tags (P0-T4:
  torch 2.7.0+cu128, flash-attn cp311 wheel, spconv-cu124, PyG +pt27cu128, numpy re-pinned,
  triton-windows — flash-attn imports triton at module load). No source builds; a recipe that needs
  a compiler is not shippable.
- Platform gates are honest: dependencies that import `flash_attn`/`spconv` unconditionally are
  CUDA-only, so the catalog entry says `platforms: [windows-cuda, linux-cuda]` and macOS is excluded
  with a message, not a crash (D-009; the P0-T4 platform verdict).
