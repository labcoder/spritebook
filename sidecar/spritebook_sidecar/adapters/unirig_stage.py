"""Launcher for one UniRig stage, executed INSIDE the UniRig virtualenv.

This file never runs in the sidecar's own interpreter — the sidecar env is
deliberately light (no torch, no bpy). It is handed to
``spikes/autorig/.venv/Scripts/python.exe`` as a plain script path, with the
UniRig clone as the working directory, and it does two things upstream cannot
be asked to do for us:

1. **Runs the stage in a disposable subprocess** (sidecar-vram law). bpy stages
   crash 0xC0000005 at interpreter teardown AFTER writing their output, so the
   caller validates artifacts and ignores exit codes; a fresh process per stage
   is what makes that safe.
2. **Installs the checkpoint-unpickler shim in-process instead of patching
   upstream.** torch >= 2.6 defaults ``torch.load(weights_only=True)`` and
   UniRig's skin checkpoint embeds a ``box.Box``, so Lightning's restore fails
   on a pristine clone (P0-T4 patch #2). Rather than edit ``run.py``, ``--trust-
   checkpoints`` wraps ``torch.load`` for this process only. The trust anchor is
   the registry's pinned sha256 for the checkpoint file (D-009), never the
   loader flag and never the download source — which is also why the caller
   points ``resume_from_checkpoint`` at the installed ``modelDir`` and sets
   ``HF_HUB_OFFLINE=1``.

Usage (argument lists only, never a shell string):

    python unirig_stage.py --script run.py [--trust-checkpoints] -- <argv...>
    python unirig_stage.py --module src.data.extract -- <argv...>
"""

from __future__ import annotations

import runpy
import sys


def _trust_checkpoints() -> None:
    """Force ``torch.load`` onto the full unpickler for this process.

    OVERRIDE, not ``setdefault``: Lightning passes ``weights_only`` EXPLICITLY
    (``checkpoint_io.load_checkpoint(path, weights_only=...)`` ->
    ``cloud_io._load`` -> ``torch.load(..., weights_only=weights_only)``), so a
    default can never apply and the shim silently did nothing — the live run
    failed on exactly the ``box.Box`` unpickling error this exists to prevent.

    Safe here for one reason only: the registry verified this checkpoint's
    pinned sha256 before it reached disk (D-009). The trust anchor is that
    hash, never the loader flag and never the download source.
    """
    import torch

    original = torch.load

    def load(*args, **kwargs):  # noqa: ANN002, ANN003 - a pass-through wrapper
        kwargs["weights_only"] = False
        return original(*args, **kwargs)

    torch.load = load


def main(argv: list[str]) -> int:
    script: str | None = None
    module: str | None = None
    trust = False
    rest: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--script":
            script = argv[i + 1]
            i += 2
        elif arg == "--module":
            module = argv[i + 1]
            i += 2
        elif arg == "--trust-checkpoints":
            trust = True
            i += 1
        elif arg == "--":
            rest = argv[i + 1 :]
            break
        else:
            raise SystemExit(f"unirig_stage: unexpected argument {arg!r}")
    if (script is None) == (module is None):
        raise SystemExit("unirig_stage: exactly one of --script / --module is required")

    if trust:
        _trust_checkpoints()

    target = script if script is not None else str(module)
    sys.argv = [target, *rest]
    # The stage's own directory (the UniRig clone, our cwd) must be importable:
    # `src.*` is a package relative to it and `python <path>` does not add cwd.
    sys.path.insert(0, "")
    if script is not None:
        runpy.run_path(script, run_name="__main__")
    else:
        runpy.run_module(str(module), run_name="__main__", alter_sys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
