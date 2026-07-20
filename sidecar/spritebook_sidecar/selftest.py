"""Self-test: exercises the real server over real HTTP, the echo adapter end
to end, the pose heuristic on synthetic silhouettes, and the rembg adapter's
offline model-missing path — no network, no u2net weight, no pytest.

Run:  uv run --project sidecar python -m spritebook_sidecar.selftest
Exits nonzero on the first failure.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from .adapters import AdapterError, build_registry
from .adapters.pose_check import build_preflight_report, run_checks
from .events import JobEmitter, iso_now
from .server import build_server

TOKEN = "selftest-token-0123456789abcdef"
AT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

EVENT_KEYS = {
    "queued": {"t", "jobId", "at"},
    "started": {"t", "jobId", "at"},
    "progress": {"t", "jobId", "at", "step", "done", "total"},
    "artifact": {"t", "jobId", "at", "kind", "path"},
    "warn": {"t", "jobId", "at", "code", "message"},
    "error": {"t", "jobId", "at", "code", "message", "retryable"},
    "done": {"t", "jobId", "at", "wallTimeS"},
}

_checks = 0


def ok(cond: bool, label: str) -> None:
    global _checks
    if not cond:
        raise AssertionError(f"FAIL: {label}")
    _checks += 1


def assert_event_shape(ev: dict[str, Any], job_id: str) -> None:
    t = ev.get("t")
    ok(t in EVENT_KEYS, f"event type known: {t}")
    ok(set(ev.keys()) == EVENT_KEYS[t], f"{t} has EXACTLY the strict keys, got {sorted(ev)}")
    ok(ev["jobId"] == job_id, f"{t} carries jobId {job_id}")
    ok(bool(AT_RE.match(ev["at"])), f"{t}.at is ISO UTC ms Z: {ev['at']}")


# --- HTTP helpers -------------------------------------------------------------


def http_json(
    port: int, method: str, path: str, token: str | None, body: dict | None = None
) -> tuple[int, Any]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    payload = None
    if body is not None:
        payload = json.dumps(body)
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=payload, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    return resp.status, (json.loads(raw) if raw else None)


def stream_job(
    port: int, payload: dict, on_line=None
) -> tuple[int, str, list[dict[str, Any]]]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
    conn.request(
        "POST",
        "/jobs",
        body=json.dumps(payload),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
    )
    resp = conn.getresponse()
    ctype = resp.getheader("Content-Type", "")
    if resp.status != 200:
        raw = resp.read()
        conn.close()
        return resp.status, ctype, [json.loads(raw)] if raw else []
    events: list[dict[str, Any]] = []
    while True:
        line = resp.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        ev = json.loads(line)
        events.append(ev)
        if on_line is not None:
            on_line(ev)
    conn.close()
    return resp.status, ctype, events


# --- test groups ---------------------------------------------------------------


def test_auth_and_routes(port: int) -> None:
    status, body = http_json(port, "GET", "/handshake", token=None)
    ok(status == 401, "missing token -> 401")
    ok(body == {"error": "unauthorized"}, "401 body is JSON error")
    status, _ = http_json(port, "GET", "/handshake", token="wrong-token")
    ok(status == 401, "wrong token -> 401")
    status, _ = http_json(port, "POST", "/shutdown", token="wrong-token", body={})
    ok(status == 401, "shutdown with wrong token -> 401")
    status, body = http_json(port, "GET", "/nope", token=TOKEN)
    ok(status == 404, "unknown route -> 404")
    ok(body.get("error") == "not-found", "404 body is JSON error")


def test_handshake(port: int) -> None:
    status, hs = http_json(port, "GET", "/handshake", token=TOKEN)
    ok(status == 200, "/handshake -> 200")
    ok(
        set(hs.keys()) == {"contractVersion", "sidecarVersion", "python", "adapters"},
        "handshake has exactly the SidecarHandshake keys",
    )
    ok(hs["contractVersion"] == 1, "contractVersion is 1")
    ok(hs["sidecarVersion"] == "0.1.0", "sidecarVersion is 0.1.0")
    ok(
        re.match(r"^\d+\.\d+\.\d+$", hs["python"]) is not None,
        f"python is major.minor.micro: {hs['python']}",
    )
    ids = [a["id"] for a in hs["adapters"]]
    ok(ids == ["echo", "rembg", "pose-check"], f"the three adapters announced: {ids}")
    for a in hs["adapters"]:
        ok(
            {"id", "kind", "version", "paramsSchema", "defaults"} <= set(a.keys())
            and set(a.keys())
            <= {"id", "kind", "version", "paramsSchema", "defaults", "description"},
            f"adapter {a['id']} matches SidecarAdapterSchema keys",
        )
        ok(a["kind"] in {"imageprep", "gen3d", "rig", "test"}, f"adapter {a['id']} kind valid")
        ok(isinstance(a["paramsSchema"], dict) and isinstance(a["defaults"], dict),
           f"adapter {a['id']} schema/defaults are objects")
    by_id = {a["id"]: a for a in hs["adapters"]}
    ok(by_id["echo"]["kind"] == "test", "echo kind is test")
    ok(by_id["rembg"]["kind"] == "imageprep", "rembg kind is imageprep")
    ok(by_id["echo"]["defaults"] == {"steps": 3, "delayMs": 10}, "echo defaults exact")
    ok(by_id["rembg"]["defaults"] == {"model": "u2net"}, "rembg defaults exact")


def test_echo_job(port: int, tmp: Path) -> None:
    out_dir = tmp / "echo out dir"  # space on purpose: Windows-first paths
    job_id = "selftest-echo-1"
    status, ctype, events = stream_job(
        port,
        {
            "jobId": job_id,
            "kind": "echo",
            "params": {"steps": 4, "delayMs": 5, "outDir": str(out_dir)},
        },
    )
    ok(status == 200, "echo job -> 200")
    ok(ctype.startswith("application/x-ndjson"), f"content-type is NDJSON: {ctype}")
    for ev in events:
        assert_event_shape(ev, job_id)
    kinds = [e["t"] for e in events]
    ok(
        kinds == ["queued", "started", "progress", "progress", "progress", "progress", "artifact", "done"],
        f"echo event sequence exact: {kinds}",
    )
    progress = [e for e in events if e["t"] == "progress"]
    ok([p["done"] for p in progress] == [1, 2, 3, 4], "progress done counts 1..4")
    ok(all(p["total"] == 4 for p in progress), "progress totals all 4")
    ok(all(p["step"] == "echo" for p in progress), "progress step is 'echo'")
    artifact = events[-2]
    ok(artifact["kind"] == "echo-log", "artifact kind echo-log")
    ok(os.path.isabs(artifact["path"]), "artifact path is absolute")
    ok(Path(artifact["path"]).is_file(), "echo.txt exists")
    ok(
        Path(artifact["path"]).read_text(encoding="utf-8")
        == "step 1\nstep 2\nstep 3\nstep 4\n",
        "echo.txt content is one line per step",
    )
    done = events[-1]
    ok(isinstance(done["wallTimeS"], (int, float)) and done["wallTimeS"] >= 0,
       "done.wallTimeS is a nonnegative number")


def test_echo_failure(port: int, tmp: Path) -> None:
    job_id = "selftest-echo-fail"
    out_dir = tmp / "echo-fail"
    status, _, events = stream_job(
        port,
        {
            "jobId": job_id,
            "kind": "echo",
            "params": {"steps": 3, "delayMs": 5, "outDir": str(out_dir), "failAt": 2},
        },
    )
    ok(status == 200, "failing echo job still 200 (failure travels in-stream)")
    for ev in events:
        assert_event_shape(ev, job_id)
    kinds = [e["t"] for e in events]
    ok(kinds == ["queued", "started", "progress", "progress", "error"],
       f"failAt sequence exact: {kinds}")
    err = events[-1]
    ok(err["code"] == "echo-fail", "error code echo-fail")
    ok(err["retryable"] is False, "echo-fail not retryable")
    ok("step 2" in err["message"], "error message names the failing step")
    ok(not (out_dir / "echo.txt").exists(), "no artifact written on failure")


def test_unknown_adapter(port: int) -> None:
    job_id = "selftest-unknown"
    status, _, events = stream_job(
        port, {"jobId": job_id, "kind": "nope", "params": {}}
    )
    ok(status == 200, "unknown adapter still streams NDJSON")
    for ev in events:
        assert_event_shape(ev, job_id)
    kinds = [e["t"] for e in events]
    ok(kinds == ["queued", "error"], f"unknown adapter sequence: {kinds}")
    err = events[-1]
    ok(err["code"] == "unknown-adapter", "error code unknown-adapter")
    ok(err["retryable"] is False, "unknown-adapter not retryable")
    for aid in ("echo", "rembg", "pose-check"):
        ok(aid in err["message"], f"message lists available id {aid}")


def test_bad_requests(port: int) -> None:
    status, body = http_json(port, "POST", "/jobs", token=TOKEN, body={"nope": 1})
    ok(status == 400, "malformed job request -> 400")
    status, body = http_json(
        port, "POST", "/jobs", token=TOKEN,
        body={"jobId": "UPPER_case!", "kind": "echo", "params": {}},
    )
    ok(status == 400, "invalid jobId slug -> 400")


def test_single_flight(port: int, tmp: Path) -> None:
    job_id = "selftest-long"
    started = threading.Event()
    result: dict[str, Any] = {}

    def long_job() -> None:
        def on_line(ev: dict[str, Any]) -> None:
            if ev["t"] == "started":
                started.set()

        status, _, events = stream_job(
            port,
            {
                "jobId": job_id,
                "kind": "echo",
                "params": {"steps": 20, "delayMs": 100, "outDir": str(tmp / "long")},
            },
            on_line=on_line,
        )
        result["status"] = status
        result["events"] = events

    t = threading.Thread(target=long_job)
    t.start()
    ok(started.wait(timeout=10), "long job reached 'started'")
    status, body = http_json(
        port, "POST", "/jobs", token=TOKEN,
        body={"jobId": "selftest-second", "kind": "echo",
              "params": {"steps": 1, "delayMs": 0, "outDir": str(tmp / "second")}},
    )
    ok(status == 409, "second concurrent job -> 409")
    ok(body.get("error") == "job-already-running", "409 body names job-already-running")
    t.join(timeout=30)
    ok(not t.is_alive(), "long job finished")
    ok(result["status"] == 200 and result["events"][-1]["t"] == "done",
       "long job completed with done after the 409")
    # lock released: a fresh job runs
    status, _, events = stream_job(
        port,
        {"jobId": "selftest-after", "kind": "echo",
         "params": {"steps": 1, "delayMs": 0, "outDir": str(tmp / "after")}},
    )
    ok(status == 200 and events[-1]["t"] == "done", "lock released after job ends")


# --- pose heuristic on synthetic silhouettes -----------------------------------


def _statuses(checks: list[dict[str, str]]) -> dict[str, str]:
    ok([c["id"] for c in checks] == ["loaded", "cutout", "pose", "resolution"],
       "checks are loaded, cutout, pose, resolution in order")
    for c in checks:
        ok(c["status"] in {"ok", "warn"}, f"check {c['id']} status valid")
        ok(isinstance(c["message"], str) and len(c["message"]) > 0,
           f"check {c['id']} has a message")
        ok(set(c.keys()) == {"id", "status", "message"}, f"check {c['id']} strict keys")
    return {c["id"]: c["status"] for c in checks}


def test_pose_checks() -> None:
    # T-pose-ish: vertical torso + wide horizontal arm bar in the arm band.
    tpose = np.zeros((600, 600), dtype=np.uint8)
    tpose[120:481, 270:331] = 255  # torso: rows 120..480, 61 px wide
    tpose[200:241, 100:501] = 255  # arms: rows 200..240, 401 px wide
    st = _statuses(run_checks(tpose))
    ok(st["pose"] == "ok", f"T-pose blob -> pose ok (got {st['pose']})")
    ok(st["cutout"] == "ok", "T-pose blob -> cutout ok")
    ok(st["resolution"] == "ok", "T-pose blob -> resolution ok")

    # Narrow column: arms indistinguishable from torso.
    column = np.zeros((600, 600), dtype=np.uint8)
    column[50:551, 280:321] = 255
    st = _statuses(run_checks(column))
    ok(st["pose"] == "warn", "narrow column -> pose warn")

    # Tiny image: resolution warn.
    tiny = np.zeros((200, 300), dtype=np.uint8)
    tiny[40:161, 100:201] = 255
    st = _statuses(run_checks(tiny))
    ok(st["resolution"] == "warn", "tiny image -> resolution warn")

    # Full-frame alpha: cutout warn (nothing removed).
    full = np.full((600, 600), 255, dtype=np.uint8)
    st = _statuses(run_checks(full))
    ok(st["cutout"] == "warn", "full-frame alpha -> cutout warn")

    # Degenerate: empty alpha must not crash.
    empty = np.zeros((600, 600), dtype=np.uint8)
    st = _statuses(run_checks(empty))
    ok(st["pose"] == "warn", "empty alpha -> pose warn, no crash")
    ok(st["cutout"] == "warn", "empty alpha -> cutout warn")

    report = build_preflight_report(tpose)
    ok(set(report.keys()) == {"at", "checks"}, "PreflightReport has exactly at+checks")
    ok(bool(AT_RE.match(report["at"])), "PreflightReport.at is ISO UTC ms Z")


def test_rembg_model_missing(tmp: Path) -> None:
    from .adapters import rembg_cutout
    from PIL import Image

    img_path = tmp / "input.png"
    Image.new("RGB", (64, 64), (200, 60, 60)).save(img_path)
    empty_model_dir = tmp / "empty models"
    empty_model_dir.mkdir(parents=True, exist_ok=True)

    emitted: list[dict[str, Any]] = []
    emitter = JobEmitter("selftest-rembg", emitted.append)
    t0 = time.monotonic()
    try:
        rembg_cutout.run(
            {
                "imagePath": str(img_path),
                "outDir": str(tmp / "rembg-out"),
                "modelDir": str(empty_model_dir),
            },
            emitter,
        )
        raise AssertionError("FAIL: rembg run() should have raised model-missing")
    except AdapterError as exc:
        elapsed = time.monotonic() - t0
        ok(exc.code == "model-missing", f"AdapterError code model-missing: {exc.code}")
        ok(exc.retryable is False, "model-missing not retryable")
        expected = str((empty_model_dir / "u2net.onnx").resolve())
        ok(expected in exc.message, "message names the exact expected path")
        ok("spritebook models install rembg-u2net" in exc.message,
           "message names the install fix")
        ok(elapsed < 5.0, f"fails fast without network ({elapsed:.3f}s)")
        ok(emitted == [], "no events emitted before the model check")


def test_events_module() -> None:
    ok(bool(AT_RE.match(iso_now())), "iso_now matches ISO UTC ms Z")
    emitted: list[dict[str, Any]] = []
    em = JobEmitter("job-1", emitted.append)
    em.progress("s", 0, 1)
    em.artifact("k", "C:/x/y.png")
    em.warn("c", "m")
    for ev in emitted:
        ok(set(ev.keys()) == EVENT_KEYS[ev["t"]], f"emitter {ev['t']} strict keys")
    try:
        em.progress("s", -1, 1)
        raise AssertionError("FAIL: negative done must be rejected")
    except ValueError:
        ok(True, "negative progress.done rejected")
    try:
        em.progress("s", 1, 0)
        raise AssertionError("FAIL: zero total must be rejected")
    except ValueError:
        ok(True, "nonpositive progress.total rejected")


def test_shutdown(port: int, server_thread: threading.Thread) -> None:
    status, body = http_json(port, "POST", "/shutdown", token=TOKEN, body={})
    ok(status == 202, "/shutdown -> 202")
    server_thread.join(timeout=10)
    ok(not server_thread.is_alive(), "server loop exited after /shutdown")


def main() -> int:
    os.environ.pop("U2NET_HOME", None)  # prove we never rely on it
    server = build_server(0, TOKEN, build_registry())
    port = server.bound_port
    server_thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1})
    server_thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="spritebook sidecar selftest ") as tmp_s:
            tmp = Path(tmp_s)
            test_auth_and_routes(port)
            test_handshake(port)
            test_echo_job(port, tmp)
            test_echo_failure(port, tmp)
            test_unknown_adapter(port)
            test_bad_requests(port)
            test_single_flight(port, tmp)
            test_pose_checks()
            test_rembg_model_missing(tmp)
            test_events_module()
            test_shutdown(port, server_thread)
    finally:
        if server_thread.is_alive():
            server.shutdown()
            server_thread.join(timeout=5)
        server.server_close()
    print(f"PASS spritebook-sidecar selftest: {_checks} checks OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
