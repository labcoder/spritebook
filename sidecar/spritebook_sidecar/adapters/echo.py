"""Echo adapter — the built-in ``test`` kind.

Sleeps through ``steps`` progress ticks, optionally fails at ``failAt``, and
writes ``<outDir>/echo.txt``. With a large ``delayMs`` the job runs long
enough for core's death test to kill the sidecar mid-stream.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from . import Adapter, AdapterError, Emitter

PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["steps", "delayMs", "outDir"],
    "properties": {
        "steps": {"type": "integer", "minimum": 1, "maximum": 10000},
        "delayMs": {"type": "integer", "minimum": 0, "maximum": 60000},
        "outDir": {"type": "string"},
        "failAt": {"type": "integer", "minimum": 1},
    },
    "additionalProperties": False,
}

DEFAULTS: dict[str, Any] = {"steps": 3, "delayMs": 10}


def run(params: dict[str, Any], emit: Emitter) -> None:
    try:
        steps = int(params.get("steps", DEFAULTS["steps"]))
        delay_ms = int(params.get("delayMs", DEFAULTS["delayMs"]))
        out_dir = Path(str(params["outDir"]))
        fail_at = params.get("failAt")
        fail_at = int(fail_at) if fail_at is not None else None
    except (KeyError, TypeError, ValueError) as exc:
        raise AdapterError("bad-params", f"echo params invalid: {exc}", False) from exc
    if steps < 1:
        raise AdapterError("bad-params", "steps must be >= 1", False)

    for i in range(1, steps + 1):
        time.sleep(delay_ms / 1000.0)
        emit.progress("echo", i, steps)
        if fail_at == i:
            raise AdapterError("echo-fail", "requested failure at step %d" % i, False)

    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = (out_dir / "echo.txt").resolve()
    log_path.write_text(
        "".join(f"step {i}\n" for i in range(1, steps + 1)), encoding="utf-8"
    )
    emit.artifact("echo-log", str(log_path))


ADAPTER = Adapter(
    id="echo",
    kind="test",
    version="1.0.0",
    params_schema=PARAMS_SCHEMA,
    defaults=DEFAULTS,
    run=run,
    description="Built-in test adapter: N progress ticks, optional failure, echo.txt artifact.",
)
