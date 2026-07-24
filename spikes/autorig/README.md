# P0-T4 — auto-rig taste test (UniRig)

**Throwaway by contract** (see `docs/internal/roadmap/p0.md`). Evidence lands in
[REPORT.md](./REPORT.md); the rigged `.glb`s and contact sheets under `out/` feed the maintainer's
≥2-of-3 acceptance call. Feeds decisions: D-007 (Track B rigging), the sidecar VRAM budget, and
D-009 registry platform gates.

## Layout

- `prep/` — deno + glTF-Transform scripts: download/strip/derive the 3 CC0 test meshes
- `assets/` — the 3 static input meshes + ground-truth rig JSON (committed; CC0)
- `anim/` — CC0 humanoid clip(s) for the deformation check (committed; CC0)
- `render/` — bpy contact-sheet + retarget scripts
- `tools/` — VRAM sampler, env helpers
- `UniRig/`, `.venv/`, `work/`, `out/` — gitignored (upstream clone, uv env, scratch, outputs)

## Environment (native Windows, uv)

```powershell
uv venv --python 3.11 .venv
uv pip install --python .venv torch==2.7.0 torchvision --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv -r requirements-win.txt
# prebuilt; NEVER build from source. The exact URL, recovered and re-verified 2026-07-19 (P3-T3)
# after the P0-T4 notes left it as a placeholder and the env was deleted at phase exit:
uv pip install --python .venv "https://github.com/kingbri1/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp311-cp311-win_amd64.whl"
uv pip install --python .venv triton-windows   # flash-attn imports triton at module load
uv pip install --python .venv spconv-cu124
uv pip install --python .venv torch_scatter torch_cluster -f https://data.pyg.org/whl/torch-2.7.0+cu128.html
uv pip install --python .venv numpy==1.26.4   # re-pin LAST
```

Checkpoints (~5.8 GB) auto-download from `huggingface.co/VAST-AI/UniRig` on first run into the HF
cache. WSL2-Ubuntu fallback if native wheels fail (1-hour timebox rule).

## Pipeline per mesh (seeded)

```
extract (bpy, 50k-face decimate) -> skeleton predict (AR, seed pinned)
  -> skin predict -> merge (writes rigged glb w/ materials)
  -> retarget clip -> bpy contact sheet renders
```
