"""Localhost HTTP server — stdlib only (``http.server``), no frameworks.

Wire contract: ``packages/schema/sidecar.ts`` (FROZEN, contractVersion 1).

- Binds 127.0.0.1 ONLY; never 0.0.0.0.
- Every request requires ``Authorization: Bearer <token>`` (constant-time
  compare); anything else is 401 JSON.
- ``GET /handshake``  -> 200 SidecarHandshake JSON.
- ``POST /jobs``      -> 200 ``application/x-ndjson`` chunked stream of
  JobEvents (jobs.ts vocabulary, strict shapes), one per line, flushed as
  produced, ALWAYS ending with a terminal ``done`` or ``error`` event, then
  the connection closes. One job at a time; a concurrent POST gets 409.
- ``POST /shutdown``  -> 202, then graceful exit (response finishes first).
- Anything else      -> 404 JSON.
"""

from __future__ import annotations

import hmac
import json
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import SIDECAR_CONTRACT_VERSION, SIDECAR_VERSION
from .adapters import Adapter, AdapterError
from .events import JobEmitter, ev_done, ev_error, ev_queued, ev_started, to_line

_JOB_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")  # identity.ts JobIdSchema
_KIND_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")  # sidecar.ts slug
_MAX_BODY_BYTES = 1 << 20  # 1 MiB; job requests are small by contract


def _python_version() -> str:
    v = sys.version_info
    return f"{v.major}.{v.minor}.{v.micro}"


class SidecarServer(ThreadingHTTPServer):
    """ThreadingHTTPServer carrying the session token and adapter registry."""

    daemon_threads = True

    def __init__(self, port: int, token: str, registry: dict[str, Adapter]) -> None:
        if not token:
            raise ValueError("token must be non-empty")
        super().__init__(("127.0.0.1", port), _Handler)
        self.expected_auth = f"Bearer {token}".encode("utf-8")
        self.registry = registry
        self.job_lock = threading.Lock()

    @property
    def bound_port(self) -> int:
        return int(self.server_address[1])

    def handshake(self) -> dict[str, Any]:
        return {
            "contractVersion": SIDECAR_CONTRACT_VERSION,
            "sidecarVersion": SIDECAR_VERSION,
            "python": _python_version(),
            "adapters": [a.handshake_entry() for a in self.registry.values()],
        }


def build_server(port: int, token: str, registry: dict[str, Adapter]) -> SidecarServer:
    """Bind 127.0.0.1:<port> (0 = ephemeral) and return the server."""
    return SidecarServer(port, token, registry)


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"spritebook-sidecar/{SIDECAR_VERSION}"
    sys_version = ""
    server: SidecarServer  # narrowed type

    # -- plumbing -------------------------------------------------------------

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        sys.stderr.write(f"[sidecar] {format % args}\n")
        sys.stderr.flush()

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        return hmac.compare_digest(header.encode("utf-8"), self.server.expected_auth)

    def _drain_body(self) -> None:
        """Consume an unread request body so HTTP/1.1 keep-alive stays sane.

        Responding without reading the body (401, 404, /shutdown, ...) would
        leave those bytes in the socket to be misparsed as the next request
        line. Oversized bodies are not drained; the connection closes instead.
        """
        if getattr(self, "_body_consumed", False):
            return
        self._body_consumed = True
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0
        if length <= 0:
            return
        if length > _MAX_BODY_BYTES:
            self.close_connection = True
            return
        self.rfile.read(length)

    def _send_json(self, status: int, obj: dict[str, Any]) -> None:
        self._drain_body()
        body = (json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _reject_unauthorized(self) -> bool:
        if self._authorized():
            return False
        self._send_json(401, {"error": "unauthorized"})
        return True

    # -- routes ---------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        self._body_consumed = False  # per-request; connections are reused
        if self._reject_unauthorized():
            return
        if self.path == "/handshake":
            self._send_json(200, self.server.handshake())
            return
        self._send_json(404, {"error": "not-found", "path": self.path})

    def do_POST(self) -> None:  # noqa: N802
        self._body_consumed = False  # per-request; connections are reused
        if self._reject_unauthorized():
            return
        if self.path == "/jobs":
            self._handle_jobs()
            return
        if self.path == "/shutdown":
            self._send_json(202, {"ok": True})
            self.wfile.flush()
            # Finish this response, then stop the accept loop; main() exits.
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        self._send_json(404, {"error": "not-found", "path": self.path})

    # -- POST /jobs -----------------------------------------------------------

    def _read_request(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._send_json(411, {"error": "length-required"})
            return None
        if length < 0 or length > _MAX_BODY_BYTES:
            self._body_consumed = True  # not draining an oversized body
            self.close_connection = True
            self._send_json(413, {"error": "payload-too-large"})
            return None
        raw = self.rfile.read(length)
        self._body_consumed = True
        try:
            body = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "bad-json"})
            return None
        job_id = body.get("jobId") if isinstance(body, dict) else None
        kind = body.get("kind") if isinstance(body, dict) else None
        params = body.get("params") if isinstance(body, dict) else None
        if (
            not isinstance(job_id, str)
            or not _JOB_ID_RE.match(job_id)
            or not isinstance(kind, str)
            or not _KIND_RE.match(kind)
            or not isinstance(params, dict)
        ):
            self._send_json(
                400,
                {
                    "error": "bad-request",
                    "message": "body must be {jobId, kind, params} per SidecarJobRequest",
                },
            )
            return None
        return {"jobId": job_id, "kind": kind, "params": params}

    def _start_ndjson(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def _write_event(self, event: dict[str, Any]) -> None:
        data = to_line(event).encode("utf-8")
        self.wfile.write(f"{len(data):X}\r\n".encode("ascii"))
        self.wfile.write(data)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def _end_ndjson(self) -> None:
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def _handle_jobs(self) -> None:
        request = self._read_request()
        if request is None:
            return
        job_id: str = request["jobId"]
        kind: str = request["kind"]
        params: dict[str, Any] = request["params"]

        if not self.server.job_lock.acquire(blocking=False):
            self._send_json(
                409,
                {
                    "error": "job-already-running",
                    "message": "a job is already running; retry after it completes",
                },
            )
            return

        try:
            self._stream_job(job_id, kind, params)
        except OSError as exc:
            # Client vanished mid-stream (core killed or dropped us). Nothing
            # left to write; the supervisor surfaces a retryable error.
            self.log_message("client dropped mid-stream for job %s: %s", job_id, exc)
        finally:
            self.server.job_lock.release()

    def _stream_job(self, job_id: str, kind: str, params: dict[str, Any]) -> None:
        self._start_ndjson()
        self._write_event(ev_queued(job_id))

        adapter = self.server.registry.get(kind)
        if adapter is None:
            available = ", ".join(self.server.registry.keys())
            self._write_event(
                ev_error(
                    job_id,
                    "unknown-adapter",
                    f"unknown adapter '{kind}'; available: {available}",
                    False,
                )
            )
            self._end_ndjson()
            return

        self._write_event(ev_started(job_id))
        emitter = JobEmitter(job_id, self._write_event)
        t0 = time.perf_counter()
        try:
            adapter.run(params, emitter)
        except AdapterError as exc:
            self._write_event(ev_error(job_id, exc.code, exc.message, exc.retryable))
        except OSError:
            raise  # socket death; handled by caller
        except Exception as exc:  # noqa: BLE001 — stream MUST end terminally
            sys.stderr.write(
                f"[sidecar] adapter '{kind}' crashed on job {job_id}:\n"
                f"{traceback.format_exc()}"
            )
            sys.stderr.flush()
            self._write_event(
                ev_error(job_id, "internal", f"{type(exc).__name__}: {exc}", False)
            )
        else:
            wall = round(time.perf_counter() - t0, 3)
            self._write_event(ev_done(job_id, wall))
        self._end_ndjson()
