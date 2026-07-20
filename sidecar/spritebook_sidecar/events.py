"""JobEvent emit helpers — shapes mirror ``packages/schema/jobs.ts`` EXACTLY.

Core validates every NDJSON line against zod strictObjects; an extra field is
a validation failure. Every builder here therefore produces exactly the keys
of its variant and nothing else:

    queued/started  {t, jobId, at}
    progress        {t, jobId, at, step, done, total}
    artifact        {t, jobId, at, kind, path}
    warn            {t, jobId, at, code, message}
    error           {t, jobId, at, code, message, retryable}
    done            {t, jobId, at, wallTimeS}

``at`` is ISO-8601 UTC with milliseconds and a trailing 'Z'.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Callable


def iso_now() -> str:
    """ISO-8601 UTC with millisecond precision, 'Z' suffix."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S") + f".{now.microsecond // 1000:03d}Z"


def _base(t: str, job_id: str) -> dict[str, Any]:
    return {"t": t, "jobId": job_id, "at": iso_now()}


def ev_queued(job_id: str) -> dict[str, Any]:
    return _base("queued", job_id)


def ev_started(job_id: str) -> dict[str, Any]:
    return _base("started", job_id)


def ev_progress(job_id: str, step: str, done: int, total: int) -> dict[str, Any]:
    if not step:
        raise ValueError("progress.step must be a non-empty string")
    if not isinstance(done, int) or isinstance(done, bool) or done < 0:
        raise ValueError("progress.done must be a non-negative int")
    if not isinstance(total, int) or isinstance(total, bool) or total < 1:
        raise ValueError("progress.total must be a positive int")
    ev = _base("progress", job_id)
    ev.update(step=step, done=done, total=total)
    return ev


def ev_artifact(job_id: str, kind: str, path: str) -> dict[str, Any]:
    if not kind or not path:
        raise ValueError("artifact.kind and artifact.path must be non-empty")
    ev = _base("artifact", job_id)
    ev.update(kind=kind, path=path)
    return ev


def ev_warn(job_id: str, code: str, message: str) -> dict[str, Any]:
    if not code or not message:
        raise ValueError("warn.code and warn.message must be non-empty")
    ev = _base("warn", job_id)
    ev.update(code=code, message=message)
    return ev


def ev_error(job_id: str, code: str, message: str, retryable: bool) -> dict[str, Any]:
    if not code or not message:
        raise ValueError("error.code and error.message must be non-empty")
    ev = _base("error", job_id)
    ev.update(code=code, message=message, retryable=bool(retryable))
    return ev


def ev_done(job_id: str, wall_time_s: float) -> dict[str, Any]:
    if wall_time_s < 0:
        raise ValueError("done.wallTimeS must be non-negative")
    ev = _base("done", job_id)
    ev.update(wallTimeS=wall_time_s)
    return ev


def to_line(event: dict[str, Any]) -> str:
    """One NDJSON line (newline-terminated, compact separators)."""
    return json.dumps(event, separators=(",", ":")) + "\n"


class JobEmitter:
    """The ``emit`` handle adapters receive.

    Adapters emit progress/artifact/warn only; queued/started/error/done are
    the server's responsibility (the stream's envelope).
    """

    def __init__(self, job_id: str, write: Callable[[dict[str, Any]], None]) -> None:
        self.job_id = job_id
        self._write = write

    def progress(self, step: str, done: int, total: int) -> None:
        self._write(ev_progress(self.job_id, step, done, total))

    def artifact(self, kind: str, path: str) -> None:
        self._write(ev_artifact(self.job_id, kind, path))

    def warn(self, code: str, message: str) -> None:
        self._write(ev_warn(self.job_id, code, message))
