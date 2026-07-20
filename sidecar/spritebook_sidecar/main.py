"""Sidecar entrypoint.

Spawn contract (sidecar.ts, FROZEN):

- Core passes the auth token in ``SPRITEBOOK_SIDECAR_TOKEN`` (env, never
  argv — argv is world-readable) and ``--port 0`` for an ephemeral port.
- On start the sidecar binds 127.0.0.1 only and prints EXACTLY ONE stdout
  line — the SidecarListening JSON ``{"t":"listening","port":...,"pid":...}``
  — then never writes stdout again. All logging goes to stderr.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import SIDECAR_TOKEN_ENV, SIDECAR_VERSION
from .adapters import build_registry
from .server import build_server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="spritebook-sidecar",
        description=f"SpriteBook Python sidecar {SIDECAR_VERSION} (localhost only)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="port to bind on 127.0.0.1 (default 0 = ephemeral)",
    )
    args = parser.parse_args(argv)

    token = os.environ.get(SIDECAR_TOKEN_ENV, "")
    if not token:
        print(
            f"error: {SIDECAR_TOKEN_ENV} is missing or empty; core must mint a "
            "per-session token and pass it in the environment",
            file=sys.stderr,
            flush=True,
        )
        return 2

    if not 0 <= args.port <= 65535:
        print(f"error: --port {args.port} is out of range 0-65535", file=sys.stderr, flush=True)
        return 2

    server = build_server(args.port, token, build_registry())

    # The ONLY stdout write of this process's lifetime, then stdout is
    # repointed at stderr so any stray print can never corrupt the channel.
    listening = {"t": "listening", "port": server.bound_port, "pid": os.getpid()}
    sys.stdout.write(json.dumps(listening, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    sys.stdout = sys.stderr

    print(
        f"[sidecar] {SIDECAR_VERSION} listening on 127.0.0.1:{server.bound_port} "
        f"(pid {os.getpid()})",
        file=sys.stderr,
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("[sidecar] interrupted; shutting down", file=sys.stderr, flush=True)
    finally:
        server.server_close()
    print("[sidecar] exited cleanly", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
