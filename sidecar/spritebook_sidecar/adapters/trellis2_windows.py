"""Compatibility for the pinned Windows Triton/TinyCC stack; no binary changes."""
from __future__ import annotations

import os
from pathlib import Path

_installed = False


def install() -> None:
    global _installed
    if os.name != "nt" or _installed:
        return
    from triton import knobs
    from triton.runtime import build
    from triton.windows_utils import get_8dot3_short_path

    # libtriton decodes Windows ANSI environment bytes as UTF-8; Python reads UTF-16.
    knobs.getenv = os.environ.get
    original = build._cc_cmd

    def short(path: str) -> str:
        value = Path(path)
        # Output files need not exist yet, but their parent directory does.
        return str(Path(get_8dot3_short_path(str(value.parent))) / value.name)

    def command(cc, src, out, include_dirs, library_dirs, libraries, ccflags):
        if build.is_tcc(cc):
            cc, src, out = map(short, (cc, src, out))
            include_dirs = [short(p) if p else p for p in include_dirs]
            library_dirs = [short(p) for p in library_dirs]
        return original(cc, src, out, include_dirs, library_dirs, libraries, ccflags)

    build._cc_cmd = command
    _installed = True
