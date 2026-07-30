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

from .adapters import AdapterError, build_registry, validate_params
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
    ok(
        ids == ["echo", "rembg", "pose-check", "fixture-gen", "fixture-retexture",
                "trellis2", "trellis2-retexture", "texture-substage", "unirig"],
        f"every adapter announced, in registration order: {ids}",
    )
    for a in hs["adapters"]:
        ok(
            {"id", "kind", "version", "paramsSchema", "defaults"} <= set(a.keys())
            and set(a.keys())
            <= {"id", "kind", "version", "paramsSchema", "defaults", "description"},
            f"adapter {a['id']} matches SidecarAdapterSchema keys",
        )
        # mirrors SidecarAdapterSchema: a registry Capability, plus 'test'
        ok(
            a["kind"] in {"imageprep", "gen3d", "rig", "retexture", "test"},
            f"adapter {a['id']} kind valid",
        )
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


def test_non_image_input_ends_terminally(port: int, tmp: Path) -> None:
    """Review P1: an adapter-domain OSError (UnidentifiedImageError subclasses
    OSError) must end the stream with a TERMINAL error event — never masquerade
    as a dropped socket that core would misreport as retryable death."""
    not_image = tmp / "not an image.txt"
    not_image.write_text("plain text, definitely not a png", encoding="utf-8")
    out_dir = tmp / "non-image-out"
    job_id = "selftest-non-image"
    status, _, events = stream_job(
        port,
        {
            "jobId": job_id,
            "kind": "pose-check",
            "params": {"imagePath": str(not_image), "outDir": str(out_dir)},
        },
    )
    ok(status == 200, "non-image job still streams NDJSON")
    for ev in events:
        assert_event_shape(ev, job_id)
    ok(len(events) >= 3, f"stream not cut short: {[e['t'] for e in events]}")
    err = events[-1]
    ok(err["t"] == "error", f"terminal event is an error, not a drop: {err['t']}")
    ok(err["code"] == "input-invalid", f"honest code input-invalid: {err['code']}")
    ok(err["retryable"] is False, "a non-image input is never retryable")
    ok("not an image.txt" in err["message"], "message names the offending file")


def _cutout_png(path: Path, w: int = 96, h: int = 144, narrow: bool = False) -> None:
    """A deterministic figure-ish cut-out with a patterned interior."""
    import math

    from PIL import Image

    a = np.zeros((h, w, 4), dtype=np.uint8)
    half = w * (0.10 if narrow else 0.26)
    for y in range(h):
        for x in range(w):
            cx = w / 2
            if y < h * 0.22:
                inside = math.hypot(x - cx, y - h * 0.13) < w * 0.16
            elif y < h * 0.68:
                inside = abs(x - cx) < half
            else:
                inside = abs(x - cx) < half * 0.7
            if inside:
                a[y, x] = [(x * 2) % 256, (y * 3) % 256, 180, 255]
    Image.fromarray(a, "RGBA").save(path)


def test_fixture_gen_determinism(tmp: Path) -> None:
    from spritebook_sidecar.adapters import build_registry
    from spritebook_sidecar.glb import read_glb

    reg = build_registry()
    img = tmp / "fg source.png"
    _cutout_png(img)

    class _E:
        def __init__(self) -> None:
            self.art: list[tuple[str, str]] = []

        def progress(self, *a: Any) -> None:
            pass

        def artifact(self, kind: str, path: str) -> None:
            self.art.append((kind, path))

        def warn(self, *a: Any) -> None:
            pass

    def gen(out: str, seed: int, image: Path = img) -> bytes:
        e = _E()
        reg["fixture-gen"].run(
            {"imagePath": str(image), "outDir": str(tmp / out), "seed": seed}, e
        )
        ok(e.art and e.art[-1][0] == "mesh-raw", f"fixture-gen emits mesh-raw: {e.art}")
        return Path(e.art[-1][1]).read_bytes()

    a1 = gen("fg1", 7)
    a2 = gen("fg2", 7)
    b1 = gen("fg3", 8)
    ok(a1 == a2, "fixture-gen is byte-deterministic for a fixed seed")
    ok(a1 != b1, "a different seed produces different bytes")

    mesh = read_glb(tmp / "fg1" / "raw.glb")
    ok(mesh.vertex_count > 3, f"mesh has vertices ({mesh.vertex_count})")
    ok(mesh.triangle_count > 1, f"mesh has triangles ({mesh.triangle_count})")
    ok(mesh.uvs is not None, "mesh is UV-mapped")
    ok(mesh.has_base_color_texture, "mesh carries a base color texture")

    # the output must depend on the INPUT, not just the seed
    narrow = tmp / "narrow.png"
    _cutout_png(narrow, narrow=True)
    ok(gen("fg4", 7, narrow) != a1, "a different silhouette produces a different mesh")

    # B2: candidates. One job, N mesh-raw artifacts IN INDEX ORDER, seeds
    # strided by SEED_STRIDE, and candidate 0 byte-identical to a plain run of
    # the same seed - the 1-candidate contract is unchanged, just repeated.
    from spritebook_sidecar.adapters import fixture_gen as fg

    e = _E()
    reg["fixture-gen"].run(
        {"imagePath": str(img), "outDir": str(tmp / "fgc"), "seed": 7, "candidates": 3}, e
    )
    raws = [p for k, p in e.art if k == "mesh-raw"]
    ok(len(raws) == 3, f"three candidates emit three mesh-raw artifacts: {len(raws)}")
    ok(raws[0].endswith("raw.glb") and raws[1].endswith("raw-1.glb"), f"index order: {raws}")
    ok(Path(raws[0]).read_bytes() == a1, "candidate 0 is byte-identical to the plain run")
    stride_alone = gen("fgs", 7 + fg.SEED_STRIDE)
    ok(
        Path(raws[1]).read_bytes() == stride_alone,
        "candidate 1 IS the plain run at seed + SEED_STRIDE - the convention is real",
    )
    ok(
        len({Path(r).read_bytes() for r in raws}) == 3,
        "the three candidates are three different meshes",
    )


def test_fixture_gen_validation(tmp: Path) -> None:
    """An empty silhouette must fail loudly, not emit a degenerate mesh."""
    from PIL import Image

    from spritebook_sidecar.adapters import AdapterError, build_registry

    blank = tmp / "blank.png"
    Image.fromarray(np.zeros((32, 32, 4), dtype=np.uint8), "RGBA").save(blank)

    class _E:
        def progress(self, *a: Any) -> None:
            pass

        def artifact(self, *a: Any) -> None:
            raise AssertionError("FAIL: an empty cut-out must not produce an artifact")

        def warn(self, *a: Any) -> None:
            pass

    try:
        build_registry()["fixture-gen"].run(
            {"imagePath": str(blank), "outDir": str(tmp / "blank-out"), "seed": 1}, _E()
        )
    except AdapterError as exc:
        ok(exc.retryable is False, "an empty cut-out is not retryable")
        ok(bool(exc.code), f"empty cut-out fails with a code: {exc.code}")
    else:
        raise AssertionError("FAIL: an empty cut-out should have raised")


def test_texture_substage(tmp: Path) -> None:
    from spritebook_sidecar.adapters import AdapterError, build_registry
    from spritebook_sidecar.glb import build_glb, read_glb

    reg = build_registry()
    img = tmp / "ts source.png"
    _cutout_png(img)

    class _E:
        def __init__(self) -> None:
            self.art: list[tuple[str, str]] = []

        def progress(self, *a: Any) -> None:
            pass

        def artifact(self, kind: str, path: str) -> None:
            self.art.append((kind, path))

        def warn(self, *a: Any) -> None:
            pass

    e = _E()
    reg["fixture-gen"].run({"imagePath": str(img), "outDir": str(tmp / "ts-in"), "seed": 3}, e)
    raw = Path(e.art[-1][1])
    before = read_glb(raw)

    e2 = _E()
    reg["texture-substage"].run(
        {"meshPath": str(raw), "imagePath": str(img), "outDir": str(tmp / "ts-out")}, e2
    )
    ok(e2.art and e2.art[-1][0] == "texture", f"substage emits texture: {e2.art}")
    after = read_glb(Path(e2.art[-1][1]))
    ok(after.vertex_count == before.vertex_count, "vertex count unchanged by texturing")
    ok(int(after.indices.size) == int(before.indices.size), "index count unchanged")
    ok(np.array_equal(after.positions, before.positions), "positions bit-identical")
    ok(after.has_base_color_texture, "the substage output is textured")

    # a missing mesh is an actionable refusal, not a crash
    try:
        reg["texture-substage"].run(
            {"meshPath": str(tmp / "nope.glb"), "imagePath": str(img), "outDir": str(tmp / "x")},
            _E(),
        )
    except AdapterError as exc:
        ok(exc.code in ("input-missing", "glb-invalid"), f"missing mesh is actionable: {exc.code}")
        ok(exc.retryable is False, "a missing input mesh is not retryable")
    else:
        raise AssertionError("FAIL: a missing mesh should have raised")


def test_fixture_gen_over_http(port: int, tmp: Path) -> None:
    img = tmp / "http source.png"
    _cutout_png(img)
    job_id = "selftest-fixture-gen"
    status, _, events = stream_job(
        port,
        {
            "jobId": job_id,
            "kind": "fixture-gen",
            "params": {"imagePath": str(img), "outDir": str(tmp / "http out"), "seed": 5},
        },
    )
    ok(status == 200, "fixture-gen job -> 200")
    for ev in events:
        assert_event_shape(ev, job_id)
    kinds = [e["t"] for e in events]
    ok(kinds[0] == "queued" and kinds[-1] == "done", f"terminal done: {kinds}")
    art = [e for e in events if e["t"] == "artifact"]
    ok(len(art) == 1 and art[0]["kind"] == "mesh-raw", f"one mesh-raw artifact: {art}")
    ok(Path(art[0]["path"]).is_file(), "raw.glb exists on disk")


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


def _multi_mesh_glb(path: Path) -> None:
    """Two triangles, two meshes, two nodes — the second translated +10 in X.

    Hand-built rather than produced by :func:`build_glb` because the thing under
    test is exactly what ``build_glb`` never writes: several meshes under posed
    nodes, which is what the importer's border hands the rigger.
    """
    import struct

    positions = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype="<f4")
    indices = np.array([0, 1, 2], dtype="<u2")
    blob = positions.tobytes() + indices.tobytes() + b"\x00\x00"
    doc = {
        "asset": {"version": "2.0", "generator": "selftest"},
        "scene": 0,
        "scenes": [{"nodes": [0, 1]}],
        "nodes": [{"mesh": 0}, {"mesh": 1, "translation": [10.0, 0.0, 0.0]}],
        "meshes": [
            {"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "mode": 4}]},
            {"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "mode": 4}]},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
             "min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 0.0]},
            {"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 36},
            {"buffer": 0, "byteOffset": 36, "byteLength": 6},
        ],
        "buffers": [{"byteLength": len(blob)}],
    }
    json_bytes = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(blob)
    out = bytearray()
    out.extend(struct.pack("<III", 0x46546C67, 2, total))
    out.extend(struct.pack("<II", len(json_bytes), 0x4E4F534A))
    out.extend(json_bytes)
    out.extend(struct.pack("<II", len(blob), 0x004E4942))
    out.extend(blob)
    path.write_bytes(bytes(out))


def test_scene_geometry(tmp: Path) -> None:
    """The rig path's reader: every primitive, posed, in a documented order."""
    from .glb import read_scene_geometry

    path = tmp / "two meshes.glb"
    _multi_mesh_glb(path)
    scene = read_scene_geometry(path)
    ok(scene.vertex_count == 6, f"both primitives contribute vertices: {scene.vertex_count}")
    ok(scene.triangles.shape == (2, 3), f"both triangles present: {scene.triangles.shape}")
    ok(
        int(scene.triangles.max()) == 5,
        "the second primitive's indices are offset into the flattened array",
    )
    ok(
        float(scene.positions[3][0]) == 10.0 and float(scene.positions[0][0]) == 0.0,
        "the node's translation is applied to its own primitive only",
    )
    spans = scene.primitives
    ok(len(spans) == 2, "one span per primitive")
    ok(
        (spans[0].first_vertex, spans[0].vertex_count) == (0, 3)
        and (spans[1].first_vertex, spans[1].vertex_count) == (3, 3),
        "spans describe the flattening core has to reproduce",
    )
    ok(scene.has_skins is False, "a static mesh reports no skins")


def test_unirig_params() -> None:
    """paramsSchema is RigAdapterParams, and it refuses everything else."""
    from .adapters import unirig

    schema = unirig.ADAPTER.params_schema
    ok(unirig.ADAPTER.kind == "rig", "unirig announces kind 'rig'")
    ok(
        set(schema["properties"]) == {"meshPath", "outDir", "seed", "modelDir", "hints"},
        f"paramsSchema is exactly RigAdapterParams: {sorted(schema['properties'])}",
    )
    ok(schema["additionalProperties"] is False, "paramsSchema is closed")
    ok(
        set(schema["required"]) == {"meshPath", "outDir", "seed", "modelDir"},
        "hints is the only optional param",
    )

    good = {"meshPath": "a.glb", "outDir": "out", "seed": 1, "modelDir": "m"}
    for label, params, needle in [
        ("unknown param", {**good, "nope": 1}, "unknown param"),
        ("missing meshPath", {k: v for k, v in good.items() if k != "meshPath"}, "meshPath"),
        ("missing modelDir", {k: v for k, v in good.items() if k != "modelDir"}, "modelDir"),
        ("negative seed", {**good, "seed": -1}, ">= 0"),
        ("seed not an int", {**good, "seed": "42"}, "must be a integer"),
        ("empty meshPath", {**good, "meshPath": ""}, "at least 1 char"),
    ]:
        try:
            validate_params(schema, params, unirig.DEFAULTS)
            raise AssertionError(f"FAIL: {label} should be rejected")
        except AdapterError as exc:
            ok(exc.code == "bad-params", f"{label} -> bad-params")
            ok(needle in exc.message, f"{label} message names the problem: {exc.message}")

    merged = validate_params(schema, good, unirig.DEFAULTS)
    ok(merged["seed"] == 1, "an explicit seed beats the default")
    ok(validate_params(schema, {k: v for k, v in good.items() if k != "seed"},
                       unirig.DEFAULTS)["seed"] == 42, "seed defaults to the catalog's 42")

    for label, hints in [
        ("not an array", "upperarm_l"),
        ("not objects", [1, 2]),
        ("extra key", [{"joint": "a", "position": [0, 0, 0], "why": 1}]),
        ("missing position", [{"joint": "a"}]),
        ("empty joint name", [{"joint": "", "position": [0, 0, 0]}]),
        ("two components", [{"joint": "a", "position": [0, 0]}]),
        ("non-finite", [{"joint": "a", "position": [0, float("nan"), 0]}]),
    ]:
        try:
            unirig.parse_hints(hints)
            raise AssertionError(f"FAIL: hints {label} should be rejected")
        except AdapterError as exc:
            ok(exc.code == "bad-params", f"hints {label} -> bad-params")
    parsed = unirig.parse_hints([{"joint": "upperarm_l", "position": [0.1, 1.2, 0]}])
    ok(parsed == [{"joint": "upperarm_l", "position": [0.1, 1.2, 0.0]}], "a good hint survives")
    ok(unirig.parse_hints(None) == [], "absent hints are an empty list")


def test_unirig_validation() -> None:
    """The output validators, fed exactly the garbage P0-T4 catalogued."""
    from .adapters import unirig

    # --- topological order ----------------------------------------------------
    ok(
        list(unirig.topological_order(np.array([-1, 0, 1]))) == [0, 1, 2],
        "an already-ordered skeleton is left alone",
    )
    order = unirig.topological_order(np.array([-1, 2, 0]))
    ok(list(order) == [0, 2, 1], f"a child before its parent is reordered: {list(order)}")
    for label, parents, needle in [
        ("a parent cycle", np.array([1, 0]), "cycle"),
        ("an out-of-range parent", np.array([-1, 7]), "out-of-range"),
        ("a parent below -1", np.array([-2, 0]), "out-of-range"),
    ]:
        try:
            unirig.topological_order(parents)
            raise AssertionError(f"FAIL: {label} should be refused")
        except AdapterError as exc:
            ok(exc.code == "invalid-output", f"{label} -> invalid-output")
            ok(needle in exc.message, f"{label} message says what it saw: {exc.message}")

    joints = np.array([[0.0, 0, 0], [0.0, 1, 0], [0.0, 2, 0]])
    _j, _t, parents, names, indices, moved = unirig.reorder_skeleton(
        joints, joints, np.array([-1, 2, 0]), ["a", "b", "c"], np.array([[1, 0], [2, 1]])
    )
    ok(moved is True, "reorder_skeleton reports that it moved joints")
    ok(list(parents) == [-1, 0, 1], f"parents are remapped to the new order: {list(parents)}")
    ok(names == ["a", "c", "b"], f"names travel with their joints: {names}")
    ok(indices.tolist() == [[2, 0], [1, 2]], f"weight indices are remapped too: {indices.tolist()}")

    # --- weights --------------------------------------------------------------
    indices = np.array([[0, 1], [0, 1], [0, 1], [0, 1]])
    weights = np.array(
        [
            [0.5, 0.5],  # already normalized
            [0.2, 0.2],  # sums to 0.4 -> renormalized
            [0.0, 0.0],  # zero-weight vertex: guarded, never divided
            [np.nan, np.inf],  # the silent-GPU-failure signature
        ]
    )
    row_sums = np.array([1.0, 0.4, 0.0, np.nan])
    out_indices, out_weights, counts = unirig.finalize_weights(indices, weights, row_sums, 2)
    ok(counts["unnormalizedVertices"] == 3, f"unnormalized rows counted: {counts}")
    ok(counts["zeroWeightVertices"] == 2, f"zero-weight rows counted: {counts}")
    ok(np.isfinite(out_weights).all(), "no NaN or Inf survives into rig.npz")
    ok(
        abs(float(out_weights[1].sum()) - 1.0) < 1e-6,
        f"a short row is renormalized to 1: {out_weights[1]}",
    )
    ok(
        float(out_weights[2].sum()) == 0.0 and float(out_weights[3].sum()) == 0.0,
        "zero-weight rows stay zero rather than becoming NaN (P0-T4 catalog item 5)",
    )
    ok(out_indices.dtype == np.int32 and out_weights.dtype == np.float32,
       "rig.npz gets int32 indices and float32 weights")

    try:
        unirig.finalize_weights(np.array([[0, 9]]), np.array([[1.0, 0.0]]), np.array([1.0]), 2)
        raise AssertionError("FAIL: an out-of-range joint index should be refused")
    except AdapterError as exc:
        ok(exc.code == "invalid-output", "out-of-range joint index -> invalid-output")
        ok("out of bounds" in exc.message, f"message explains the consequence: {exc.message}")

    # --- the document shape rig.ts freezes ------------------------------------
    document = unirig.build_skeleton_document(
        joints=np.zeros((1, 3)),
        tails=np.ones((1, 3)),
        parents=np.array([-1]),
        names=["bone_0"],
        seed=7,
        version="36842e2b",
        vertex_count=4,
        semantic=False,
        validation={
            "nonFiniteWeights": 0,
            "unnormalizedVertices": 3,
            "zeroWeightVertices": 2,
            "retries": 1,
        },
    )
    ok(
        set(document) == {
            "schemaVersion", "backend", "seed", "joints", "semanticNames",
            "vertexCount", "influencesPerVertex", "validation",
        },
        f"rig.json has EXACTLY RigSkeleton's keys: {sorted(document)}",
    )
    ok(
        set(document["validation"]) == {
            "nonFiniteWeights", "unnormalizedVertices", "zeroWeightVertices", "retries",
        },
        "the validation block has exactly its four counts",
    )
    ok(set(document["joints"][0]) == {"name", "parent", "head", "tail"}, "RigJoint keys are exact")
    ok(document["influencesPerVertex"] == 4, "four influences per vertex, as glTF holds")
    ok(json.loads(json.dumps(document)) == document, "the document is plain JSON")


def test_unirig_naming() -> None:
    """The semantic-naming pass names what it can and admits what it cannot."""
    from .adapters import unirig
    from .adapters.unirig_humanoid_ref import HUMANOID_REFERENCE

    reference = np.array([p for _, p in HUMANOID_REFERENCE])
    ref_names = [n for n, _ in HUMANOID_REFERENCE]
    # the reference itself, scaled to a 1.7 m character sitting at the origin
    joints = reference * 1.7
    fallback = [f"bone_{i}" for i in range(joints.shape[0])]
    names, stats = unirig.semantic_names(joints, fallback)
    ok(stats["matched"] == len(ref_names), f"a perfect humanoid matches every joint: {stats}")
    ok(names[ref_names.index("upperarm_l")] == "upperarm_l", "left stays left")
    ok(names[ref_names.index("foot_r")] == "foot_r", "right stays right")
    ok(stats["mirrored"] is False, "an unmirrored skeleton is not flipped")

    # D-008 / catalog item 6: on a symmetric character the mirrored hypothesis
    # ties the direct one on float noise, and a tie must NOT swap sides.
    mirrored_input = joints * np.array([-1.0, 1.0, 1.0])
    _names, mirrored_stats = unirig.semantic_names(mirrored_input, fallback)
    ok(
        mirrored_stats["mirrored"] is False,
        "a tie between direct and mirrored keeps the direct reading",
    )
    pairs, _score = unirig._greedy_assign(mirrored_input / 1.7, reference, mirror=True)
    ok(
        ref_names[pairs[ref_names.index("upperarm_l")][0]] == "upperarm_l",
        "the mirrored hypothesis itself does map a flipped skeleton back",
    )

    # a non-humanoid (the P0-T4 giraffe case): a long body running front to back
    # is nowhere near a two-legged reference, so almost nothing may take a name
    quadruped = np.stack(
        [np.zeros(20), np.linspace(0.0, 2.0, 20), np.linspace(-3.0, 3.0, 20)], axis=1
    )
    other_names, other_stats = unirig.semantic_names(
        quadruped, [f"bone_{i}" for i in range(20)]
    )
    ok(
        other_stats["matched"] < unirig.SEMANTIC_MIN_FRACTION * 20,
        f"a non-humanoid does not get dressed up in arm names: {other_stats}",
    )
    ok(
        sum(n.startswith("bone_") for n in other_names) > 10,
        "unmatched joints keep UniRig's positional names",
    )

    flat = np.zeros((3, 3))
    flat_names, flat_stats = unirig.semantic_names(flat, ["bone_0", "bone_1", "bone_2"])
    ok(flat_stats["matched"] == 0, "a zero-height skeleton cannot be normalized, so nothing matches")
    ok(flat_names == ["bone_0", "bone_1", "bone_2"], "and the fallback names survive intact")


def test_unirig_environment(tmp: Path) -> None:
    """Missing backend and missing weights both fail EARLY and actionably."""
    from .adapters import unirig

    mesh = tmp / "rig input.glb"
    _multi_mesh_glb(mesh)
    params = {
        "meshPath": str(mesh),
        "outDir": str(tmp / "rig out"),
        "seed": 42,
        "modelDir": str(tmp / "no models"),
    }
    saved = {k: os.environ.get(k) for k in (unirig.ENV_HOME, unirig.ENV_PYTHON)}
    try:
        os.environ[unirig.ENV_HOME] = str(tmp / "no unirig here")
        os.environ[unirig.ENV_PYTHON] = str(tmp / "no python here")
        emitted: list[dict[str, Any]] = []
        t0 = time.monotonic()
        try:
            unirig.run(dict(params), JobEmitter("selftest-unirig", emitted.append))
            raise AssertionError("FAIL: a missing UniRig clone should have raised")
        except AdapterError as exc:
            elapsed = time.monotonic() - t0
            ok(exc.code == "backend-missing", f"missing clone -> backend-missing: {exc.code}")
            ok(str(tmp / "no unirig here") in exc.message, "message names the path it looked at")
            ok(unirig.ENV_HOME in exc.message, "message names the override variable")
            ok(elapsed < 5.0, f"fails fast, without importing torch ({elapsed:.3f}s)")
            ok(emitted == [], "no events before the environment check")

        # a clone that exists but no weights: the NEXT gate must fire
        fake_home = tmp / "fake unirig"
        (fake_home / "configs" / "task").mkdir(parents=True, exist_ok=True)
        (fake_home / "run.py").write_text("# not the real thing\n", encoding="utf-8")
        (fake_home / unirig.SKIN_TASK).write_text("mode: predict\n", encoding="utf-8")
        os.environ[unirig.ENV_HOME] = str(fake_home)
        os.environ[unirig.ENV_PYTHON] = sys.executable
        emitted = []
        try:
            unirig.run(dict(params), JobEmitter("selftest-unirig", emitted.append))
            raise AssertionError("FAIL: a missing modelDir should have raised")
        except AdapterError as exc:
            ok(exc.code == "model-missing", f"missing weights -> model-missing: {exc.code}")
            ok(exc.retryable is False, "model-missing is not retryable")
            for expected in (unirig.SKELETON_CKPT, unirig.SKIN_CKPT):
                ok(
                    str((Path(params["modelDir"]) / expected).resolve()) in exc.message,
                    f"message names the exact expected path for {expected}",
                )
            ok("spritebook models install unirig" in exc.message, "message names the install fix")
            ok(emitted == [], "no events before the weight check")
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


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


# --- trellis2 ------------------------------------------------------------------


class _FakeMesh:
    """Just enough mesh for the quality gate: (N, 6) PBR attributes.

    `metallic` is its own argument because it is its own failure - the measured
    correlation with base colour is +0.06, so a fake that ties them together
    would make one test look like it covers both.
    """

    def __init__(self, base_color: float, metallic: float = 0.0) -> None:
        attrs = np.zeros((64, 6), dtype=np.float32)
        attrs[:, 0:3] = base_color
        attrs[:, 3] = metallic
        # roughness/alpha stay non-zero so a detector reading the WHOLE
        # attribute block instead of columns 0..2 would pass a collapsed mesh
        attrs[:, 4:6] = 0.6
        self.attrs = attrs


class _FakePipeline:
    """Returns a collapsed mesh for the seeds in `bad`, a healthy one otherwise.

    `bad_mean` picks WHICH collapse: 0.0006 is the black one seen in generation,
    0.9987 the white one seen in retexture. The ladder must climb past both.
    """

    def __init__(self, bad: set[int], bad_mean: float = 0.0006, bad_metal: float = 0.0) -> None:
        self.bad = bad
        self.bad_mean = bad_mean
        self.bad_metal = bad_metal
        self.seeds_seen: list[int] = []
        self.preprocess_flags: list[bool] = []
        self.sampler_params: list[dict] = []

    def run(self, image, seed, pipeline_type, preprocess_image, **kw):  # noqa: ANN001
        self.seeds_seen.append(seed)
        self.preprocess_flags.append(preprocess_image)
        self.sampler_params.append(kw)
        if seed in self.bad:
            return [_FakeMesh(self.bad_mean, self.bad_metal)]
        return [_FakeMesh(0.42)]


class _RecordingEmitter:
    job_id = "selftest-trellis2"

    def __init__(self) -> None:
        self.warns: list[tuple[str, str]] = []
        self.steps: list[str] = []
        self.artifacts: list[tuple[str, str]] = []

    def progress(self, step: str, done: int, total: int) -> None:
        self.steps.append(step)

    def artifact(self, kind: str, path: str) -> None:
        self.artifacts.append((kind, path))

    def warn(self, code: str, message: str) -> None:
        self.warns.append((code, message))


def test_trellis2_collapse_detector() -> None:
    from .adapters import trellis2 as t2

    # Both thresholds are measured valleys, not tastes: healthy output spans
    # 0.147..0.723 including a deliberately dark subject at 0.18, while the
    # failures sat at 0.0415, 0.0006 (black) and 0.9987 (white).
    ok(t2.COLLAPSE_MEAN_LOW == 0.10, "low threshold is the measured 0.10")
    ok(t2.COLLAPSE_MEAN_HIGH == 0.95, "high threshold is the measured 0.95")
    ok(t2.collapsed(_FakeMesh(0.0006).attrs), "hard collapse detected")
    ok(t2.collapsed(_FakeMesh(0.0415).attrs), "the SOFT failure is detected too")
    ok(not t2.collapsed(_FakeMesh(0.1473).attrs), "worst healthy run passes")
    ok(not t2.collapsed(_FakeMesh(0.18).attrs), "a legitimately dark subject passes")

    # THE retexture spike's second failure mode. A one-sided detector passed
    # seed 2026's pure-white atlas, which bakes a featureless silhouette that
    # is no more usable than a black one.
    ok(t2.collapsed(_FakeMesh(0.9987).attrs), "white saturation is a collapse too")
    ok(t2.collapse_kind(_FakeMesh(0.9987).attrs) == "white", "and it is named white")
    ok(t2.collapse_kind(_FakeMesh(0.0006).attrs) == "black", "the dark end is named black")
    ok(t2.collapse_kind(_FakeMesh(0.42).attrs) is None, "healthy output has no kind")
    # the bright end of the healthy range must not be swept up with it
    ok(not t2.collapsed(_FakeMesh(0.723).attrs), "the brightest healthy run passes")

    # THE bug this detector was rewritten to avoid: a run whose mean is 0.0415
    # had max 0.9856 from stray texels, so a max-based check passed an unusable
    # character. Reading columns 0..2 rather than the whole block matters too.
    stray = _FakeMesh(0.0415)
    stray.attrs[0, 0:3] = 0.9856
    ok(t2.collapsed(stray.attrs), "stray bright texels do not rescue a collapsed mesh")


def test_trellis2_metal_gate() -> None:
    from .adapters import trellis2 as t2

    ok(t2.METAL_TEXEL_FRACTION == 0.60, "the measured-and-argued threshold")

    # THE failure the base-colour check cannot see. Measured on bulma: 68% of
    # runs came back majority metal, and 9 of 22 had a HEALTHY base colour, so
    # the collapse check passed every one of them.
    healthy_but_metal = _FakeMesh(0.667, metallic=1.0)
    ok(t2.collapse_kind(healthy_but_metal.attrs) is None, "base colour looks fine...")
    ok(
        t2.quality_fault(0.667, t2.metal_fraction_from_attrs(healthy_but_metal.attrs))
        is not None,
        "...and the gate still rejects it",
    )

    # the real numbers on both sides of the valley
    ok(t2.quality_fault(0.42, 0.000) is None, "r1, the good generation, passes")
    ok(t2.quality_fault(0.702, 0.017) is None, "TRELLIS.2's own flower example passes")
    for frac in (0.851, 0.903, 0.916, 0.953, 0.972, 0.990, 1.000):
        ok(t2.quality_fault(0.42, frac) is not None, f"{frac:.0%} metal is rejected")

    # a character in plate armour is legitimately part metal, and the threshold
    # is deliberately above that rather than at the bottom of the empty valley
    ok(t2.quality_fault(0.42, 0.55) is None, "an armoured character is not a failure")

    # the message says WHICH check failed - two faults sharing one sentence
    # would describe neither
    ok("chrome" in t2.quality_fault(0.42, 0.99), "the metal fault names its symptom")
    ok("no content" in t2.quality_fault(0.0006, 0.0), "the collapse fault names its own")
    # base colour is checked first, so a mesh failing BOTH reports the cheaper one
    ok("no content" in t2.quality_fault(0.0006, 0.99), "one fault reported, not two")

    # absent is not a metal claim: a decoder that emits no metallic channel at
    # all must not be read as emitting zeros OR ones
    ok(t2.metal_fraction([]) == 0.0, "an empty channel reads as no metal")

    # A GPU TENSOR, which is what generation actually hands this. The first
    # version called np.asarray straight on it and every real `gen` died with
    # "can't convert cuda:0 device type tensor to numpy" - invisible to this
    # suite, because the fakes are numpy and the retexture path reads PIL.
    class _Cudaish:
        """Quacks like a torch CUDA tensor: numpy only after .detach().cpu()."""

        def __init__(self, values) -> None:
            self._v = np.asarray(values, dtype=np.float32)

        def detach(self):  # noqa: ANN201
            return self

        def cpu(self):  # noqa: ANN201
            return self._v

        def __array__(self, *a, **k):  # noqa: ANN002, ANN003
            raise TypeError("can't convert cuda:0 device type tensor to numpy")

    got = t2.metal_fraction(_Cudaish([0.9, 0.9, 0.1]))
    ok(abs(got - 2 / 3) < 1e-6, f"a CUDA tensor is moved first, got {got}")
    ok(t2.metal_fraction(_Cudaish([0.0, 0.0])) == 0.0, "and still reads zero as zero")


def test_trellis2_retry_ladder() -> None:
    from .adapters import trellis2 as t2

    # first seed collapses, second is fine
    pipe = _FakePipeline(bad={42})
    emit = _RecordingEmitter()
    mesh, used, tried = t2.generate_with_retries(pipe, object(), 42, 2, "512", emit)
    ok(used == 43, f"retried onto the next seed, got {used}")
    ok(tried == [42, 43], f"deterministic ladder, got {tried}")
    ok(pipe.seeds_seen == [42, 43], "the pipeline saw exactly those seeds")
    ok(all(pipe.preprocess_flags), "preprocess_image=True so BiRefNet is never built")
    # these three were declared, validated and recorded in the receipt while
    # never reaching the pipeline: `--adjust guidanceStrength=12` did nothing
    sp = pipe.sampler_params[0]
    ok(sp["shape_slat_sampler_params"]["guidance_strength"] == 7.5, "shape guidance arrives")
    ok(sp["sparse_structure_sampler_params"]["steps"] == 12, "steps arrive")
    ok(sp["tex_slat_sampler_params"]["guidance_strength"] == 1.0,
       "generation keeps upstream's texture guidance - its sweep has not been run")
    # A0 (QUALITY-AUDIT.md): rescale is plumbed, defaulting to upstream's 0.0.
    # The arrival half matters more than the default half - textureGuidance
    # itself was once "declared, validated, recorded, never passed".
    ok(sp["tex_slat_sampler_params"]["guidance_rescale"] == 0.0,
       "texture guidance_rescale arrives, at upstream's 0.0 default")
    rescaled = _FakePipeline(bad=set())
    t2.generate_with_retries(
        rescaled, object(), 7, 2, "512", _RecordingEmitter(),
        texture_guidance=2.0, texture_guidance_rescale=0.2,
    )
    rp = rescaled.sampler_params[0]["tex_slat_sampler_params"]
    ok(rp == {"guidance_strength": 2.0, "guidance_rescale": 0.2},
       f"a NON-default rescale reaches the sampler, got {rp}")
    ok([c for c, _ in emit.warns] == ["texture-rejected"], "warned once, on the bad seed")
    ok(not t2.collapsed(mesh.attrs), "the returned mesh is the healthy one")

    # the WHITE mode climbs the same ladder, and the warning says which end it
    # hit - "your character came out white" and "came out black" are different
    # bug reports, and one message covering both describes neither
    white = _FakePipeline(bad={9}, bad_mean=0.9987)
    emitw = _RecordingEmitter()
    _, usedw, triedw = t2.generate_with_retries(white, object(), 9, 2, "512", emitw)
    ok((usedw, triedw) == (10, [9, 10]), f"retried past the white seed, got {triedw}")
    ok("white" in emitw.warns[0][1], f"the warning names the end: {emitw.warns[0][1]}")

    # a healthy first seed does not retry at all
    clean = _FakePipeline(bad=set())
    emit2 = _RecordingEmitter()
    _, used2, tried2 = t2.generate_with_retries(clean, object(), 7, 2, "512", emit2)
    ok((used2, tried2) == (7, [7]), "no retry when the first seed is good")
    ok(emit2.warns == [], "and no warning")

    # budget exhausted -> refuse, do NOT ship a black character
    doomed = _FakePipeline(bad={1, 2, 3})
    emit3 = _RecordingEmitter()
    try:
        t2.generate_with_retries(doomed, object(), 1, 2, "512", emit3)
        ok(False, "exhausted budget must raise")
    except AdapterError as err:
        ok(err.code == "texture-rejected", f"refusal code, got {err.code}")
        for n in (1, 2, 3):
            ok(f"seed {n}:" in err.message, f"names seed {n}: {err.message}")
        ok(err.retryable, "a different seed might work, so it is retryable")
    ok(len(doomed.seeds_seen) == 3, "tried budget+1 times, not more")


def test_trellis2_params_and_input(tmp: Path) -> None:
    from .adapters import trellis2 as t2

    p = validate_params(t2.PARAMS_SCHEMA, {
        "imagePath": "a.png", "outDir": "o", "modelDir": "m", "seed": 0,
    }, t2.DEFAULTS)
    ok(p["pipelineType"] == "512", "512 is the default tier, on measured evidence")
    ok(p["textureRetries"] == 2, "two retries takes residual failure to ~0.01%")
    ok(p["lowVram"] is True, "low VRAM on: the reason peak is ~9 GiB not ~24")

    # 12 is the ceiling because retexture, at a 37.5% per-seed rate, needs a
    # bigger ladder than generation's 2 - the value itself is catalog data
    for bad in ({"pipelineType": "1536_cascade"}, {"textureRetries": 13}, {"nope": 1}):
        try:
            validate_params(t2.PARAMS_SCHEMA, {
                "imagePath": "a.png", "outDir": "o", "modelDir": "m", "seed": 0, **bad,
            }, t2.DEFAULTS)
            ok(False, f"should have refused {bad}")
        except AdapterError as err:
            ok(err.code == "bad-params", f"bad-params for {bad}, got {err.code}")

    # an RGB image is refused by NAME, and the message says which stage produces
    # alpha - because that alpha is also what keeps the gated RMBG-2.0 unused
    from PIL import Image

    rgb = tmp / "rgb.png"
    Image.new("RGB", (8, 8), (10, 20, 30)).save(rgb)
    try:
        t2._require_rgba(rgb)
        ok(False, "an RGB input must be refused")
    except AdapterError as err:
        ok(err.code == "bad-input", f"bad-input, got {err.code}")
        ok("rembg-u2net" in err.message, "names the stage that produces the alpha")
    rgba = tmp / "rgba.png"
    Image.new("RGBA", (8, 8), (10, 20, 30, 255)).save(rgba)
    ok(t2._require_rgba(rgba).mode == "RGBA", "an RGBA input is accepted")


def test_trellis2_code_dir(tmp: Path) -> None:
    from .adapters import trellis2 as t2

    # the env override wins, so a checkout can live anywhere
    os.environ[t2.CODE_DIR_ENV] = str(tmp / "elsewhere")
    try:
        ok(t2._code_dir() == tmp / "elsewhere", "the env override wins")
    finally:
        os.environ.pop(t2.CODE_DIR_ENV, None)

    # and without it, the repo's own checkout path - relative to THIS file, not
    # to the process cwd, which is whatever core happened to spawn us in
    default = t2._code_dir()
    ok(default.name == "code" and default.parent.name == "trellis2",
       f"defaults into the repo checkout: {default}")
    ok(default.is_absolute(), "absolute, so the cwd cannot move it")

    # a missing checkout refuses with BOTH fixes named: the clone and the extra.
    # They are different problems and a user hitting one should not be told
    # about the other alone.
    os.environ[t2.CODE_DIR_ENV] = str(tmp / "nothing-here")
    try:
        t2._ensure_importable()
        ok(False, "a missing checkout must refuse")
    except AdapterError as err:
        ok(err.code == "backend-unavailable", f"backend-unavailable, got {err.code}")
        ok("git clone" in err.message, "names the clone")
        ok("--extra trellis2" in err.message, "and the dependency extra")
    finally:
        os.environ.pop(t2.CODE_DIR_ENV, None)


def test_trellis2_rembg_is_refused() -> None:
    from .adapters import trellis2 as t2

    # The gated model must never be CONSTRUCTED - `BiRefNet.__init__` calls
    # from_pretrained('briaai/RMBG-2.0', trust_remote_code=True) eagerly, which
    # is both a gated download and remote code execution.
    stub = t2._RefusedRembg(model_name="briaai/RMBG-2.0")
    ok(stub.cuda() is stub and stub.cpu() is stub, "the stub survives the load's device dance")
    ok(stub.to("cuda") is stub, "and .to()")

    # calling it means an image arrived without alpha; that is a refusal naming
    # our own prep, not a silent fetch of someone else's matting model
    try:
        stub(object())
        ok(False, "calling the stub must refuse")
    except AdapterError as err:
        ok(err.code == "bad-input", f"bad-input, got {err.code}")
        ok("spritebook prep" in err.message, "names the fix")
        ok("briaai/RMBG-2.0" in err.message, "and what it refused to fetch")


def test_trellis2_registered() -> None:
    reg = build_registry()
    ok("trellis2" in reg, "trellis2 is in the adapter registry")
    ok(reg["trellis2"].kind == "gen3d", "declared as gen3d")
    ok("trellis2-retexture" in reg, "the retexture adapter is registered too")
    ok(reg["trellis2-retexture"].kind == "retexture", "declared as retexture")
    # a verb resolves by KIND, so the kind is the load-bearing field: it is what
    # a second texturing backend would declare to be found in trellis2's place
    kinds = [a.kind for a in reg.values()]
    ok(kinds.count("retexture") == 2, f"the real one and the GPU-free stand-in: {kinds}")


# --- trellis2 retexture ---------------------------------------------------------


class _FakeVisual:
    def __init__(self, mean: float | None, uv: object | None, metallic: float | None) -> None:
        self.uv = uv
        self.material = None if mean is None else _FakeMaterial(mean, metallic)


class _FakeMaterial:
    def __init__(self, mean: float, metallic: float | None) -> None:
        self.baseColorTexture = _FakeImage(mean)
        # absent unless asked for: a mesh with no metallicRoughness texture is
        # making no metal claim, and must not read as one
        if metallic is not None:
            self.metallicRoughnessTexture = _FakeMRImage(metallic)


class _FakeImage:
    """Stands in for a PIL atlas: `.convert('RGB')` into a uint8 array."""

    def __init__(self, mean: float) -> None:
        self._mean = mean

    def convert(self, mode: str):  # noqa: ANN201
        return np.full((4, 4, 3), round(self._mean * 255), dtype=np.uint8)


class _FakeMRImage:
    """glTF packs roughness in GREEN and metallic in BLUE (trellis2_texturing:351).

    Red stays 0 exactly as the real writer leaves it, so a reader that grabs the
    wrong channel measures 0 metal and fails loudly rather than passing quietly.
    """

    def __init__(self, metallic: float) -> None:
        self._metallic = metallic

    def convert(self, mode: str):  # noqa: ANN201
        a = np.zeros((4, 4, 3), dtype=np.uint8)
        a[:, :, 1] = 153                                  # roughness 0.6
        a[:, :, 2] = round(self._metallic * 255)
        return a


class _FakeTexturedMesh:
    def __init__(self, mean: float | None = 0.42, bounds=None, uv: object = "present",
                 metallic: float | None = None) -> None:
        self.visual = _FakeVisual(mean, uv, metallic)
        self.bounds = bounds if bounds is not None else [[-0.4, -0.5, -0.1], [0.4, 0.5, 0.1]]
        self.exported: list[str] = []

    def export(self, path: str) -> None:
        self.exported.append(path)


def test_retexture_collapse_and_ladder() -> None:
    from .adapters import trellis2_retexture as rt

    # the atlas mean is read off the BAKED texture, not off PBR attributes -
    # this path has no `.attrs` at all - but lands on the same [0, 1] scale
    ok(abs(rt.atlas_mean(_FakeTexturedMesh(0.5)) - 0.5) < 0.01, "atlas mean is [0, 1]")
    ok(rt.atlas_mean(_FakeTexturedMesh(None)) == 0.0, "no texture at all reads as empty")

    # BOTH modes, on the retexture path: black was found in generation, white
    # was found HERE (seed 2026, mean 0.9987)
    for mean, kind in ((0.0824, "black"), (0.9987, "white"), (0.5714, None)):
        got = t2_kind(rt.atlas_mean(_FakeTexturedMesh(mean)))
        ok(got == kind, f"atlas mean {mean} reads as {kind}, got {got}")

    calls: list[int] = []

    class _Pipe:
        def __init__(self, bad: dict[int, float]) -> None:
            self.bad = bad

        def run(self, mesh, image, seed, resolution, texture_size, preprocess_image, **kw):  # noqa: ANN001
            calls.append(seed)
            self.kw = kw
            return _FakeTexturedMesh(self.bad.get(seed, 0.42))

    # the measured failures on one mesh: 7 black, 2026 white. The ladder must
    # climb past both without caring which it hit.
    emit = _RecordingEmitter()
    pipe = _Pipe({7: 0.0064, 8: 0.9987})
    out, used, tried = rt.retexture_with_retries(
        pipe, object(), object(), 7, 5, 512, 2048, emit
    )
    ok((used, tried) == (9, [7, 8, 9]), f"climbed past black AND white, got {tried}")
    ok(calls == [7, 8, 9], f"the pipeline saw exactly those seeds: {calls}")
    ok("a black texture" in emit.warns[0][1], f"named the dark end: {emit.warns[0][1]}")
    ok("a white texture" in emit.warns[1][1], f"named the bright end: {emit.warns[1][1]}")
    ok(rt.atlas_mean(out) > 0.1, "the returned mesh is the healthy one")
    # A0: rescale arrives on the retexture path too, defaulting to upstream 0.0
    ok(pipe.kw["tex_slat_sampler_params"] == {"guidance_strength": 7.5, "guidance_rescale": 0.0},
       f"texture sampler params carry rescale at 0.0, got {pipe.kw['tex_slat_sampler_params']}")
    tuned = _Pipe({})
    rt.retexture_with_retries(
        tuned, object(), object(), 7, 5, 512, 2048, _RecordingEmitter(),
        texture_guidance=2.0, texture_guidance_rescale=0.2,
    )
    ok(tuned.kw["tex_slat_sampler_params"] == {"guidance_strength": 2.0, "guidance_rescale": 0.2},
       f"a NON-default rescale reaches the retexture sampler, got {tuned.kw['tex_slat_sampler_params']}")

    # the metal fault climbs the SAME ladder: a healthy base colour is not a
    # pass, which is exactly the case that shipped before this gate existed
    class _MetalPipe:
        def run(self, mesh, image, seed, resolution, texture_size, preprocess_image, **kw):  # noqa: ANN001
            return _FakeTexturedMesh(0.667, metallic=1.0 if seed < 3 else 0.0)

    emitm = _RecordingEmitter()
    _, usedm, triedm = rt.retexture_with_retries(
        _MetalPipe(), object(), object(), 1, 5, 512, 2048, emitm
    )
    ok((usedm, triedm) == (3, [1, 2, 3]), f"climbed past the chrome seeds, got {triedm}")
    ok("all-metal" in emitm.warns[0][1], f"named the fault: {emitm.warns[0][1]}")
    ok(rt.atlas_metal_fraction(_FakeTexturedMesh(0.4, metallic=1.0)) == 1.0, "reads BLUE")
    ok(rt.atlas_metal_fraction(_FakeTexturedMesh(0.4)) == 0.0, "no map, no metal claim")

    # exhausted: refuse rather than write a blank character, and say so in the
    # terms of THIS operation - the input mesh survives, so a retry is cheap
    doomed = _Pipe({n: 0.0 for n in range(100, 110)})
    try:
        rt.retexture_with_retries(doomed, object(), object(), 100, 2, 512, 2048, _RecordingEmitter())
        ok(False, "an exhausted budget must raise")
    except AdapterError as err:
        ok(err.code == "texture-rejected", f"refusal code, got {err.code}")
        for n in (100, 101, 102):
            ok(f"seed {n}:" in err.message, f"names seed {n}: {err.message}")
        ok("input mesh is untouched" in err.message, "the remedy suits retexture")
        ok(err.retryable, "another seed might work")


def t2_kind(mean: float) -> str | None:
    from .adapters import trellis2 as t2

    return t2.kind_for_mean(mean)


def test_retexture_frame_guard() -> None:
    from .adapters import trellis2_retexture as rt

    src = _FakeTexturedMesh()
    # what the spike actually measured: bounds move ~0.1% of extent across seeds
    settled = _FakeTexturedMesh(bounds=[[-0.4001, -0.4999, -0.1], [0.3999, 0.5001, 0.1]])
    ok(rt.frame_shift(src, settled) < rt.FRAME_TOLERANCE, "measured drift passes")

    # the two failures worth catching. An un-inverted axis swap permutes the
    # per-axis extents of anything that is not a cube...
    swapped = _FakeTexturedMesh(bounds=[[-0.4, -0.1, -0.5], [0.4, 0.1, 0.5]])
    ok(rt.frame_shift(src, swapped) > rt.FRAME_TOLERANCE, "an axis swap is caught")
    # ...and a rescale is caught whenever the input was not already unit-sized
    scaled = _FakeTexturedMesh(bounds=[[-0.8, -1.0, -0.2], [0.8, 1.0, 0.2]])
    ok(rt.frame_shift(src, scaled) > rt.FRAME_TOLERANCE, "a rescale is caught")
    # a pure translation moves no extent at all, so the centre term is what sees it
    moved = _FakeTexturedMesh(bounds=[[-0.3, -0.4, 0.0], [0.5, 0.6, 0.2]])
    ok(rt.frame_shift(src, moved) > rt.FRAME_TOLERANCE, "a translation is caught")

    try:
        rt.frame_shift(_FakeTexturedMesh(bounds=[[0, 0, 0], [0, 0, 0]]), src)
        ok(False, "a zero-extent input must be refused, not divided by")
    except AdapterError as err:
        ok(err.code == "bad-input", f"bad-input, got {err.code}")


def test_retexture_params_and_uv() -> None:
    from .adapters import trellis2_retexture as rt

    p = validate_params(rt.PARAMS_SCHEMA, {
        "meshPath": "m.glb", "imagePath": "a.png", "outDir": "o", "modelDir": "m", "seed": 0,
    }, rt.DEFAULTS)
    # 5, not gen's 2: the same decoder collapses on 37.5% of seeds here against
    # ~5% there, and 2 retries would leave a 5.3% residual
    ok(p["textureRetries"] == 5, f"the longer ladder is the default: {p['textureRetries']}")
    ok(p["resolution"] == 512, "512: half the VRAM, two-thirds the time, no quality cost")

    for bad in ({"resolution": 2048}, {"textureRetries": 13}, {"nope": 1}):
        try:
            validate_params(rt.PARAMS_SCHEMA, {
                "meshPath": "m.glb", "imagePath": "a.png", "outDir": "o",
                "modelDir": "m", "seed": 0, **bad,
            }, rt.DEFAULTS)
            ok(False, f"should have refused {bad}")
        except AdapterError as err:
            ok(err.code == "bad-params", f"bad-params for {bad}, got {err.code}")
    # a mesh is required: this operation has nothing to repaint without one
    try:
        validate_params(rt.PARAMS_SCHEMA, {
            "imagePath": "a.png", "outDir": "o", "modelDir": "m", "seed": 0,
        }, rt.DEFAULTS)
        ok(False, "meshPath is required")
    except AdapterError as err:
        ok(err.code == "bad-params", f"bad-params, got {err.code}")

    # UVs decide whether topology survives, so the answer is detected, not assumed
    ok(rt.has_uv(_FakeTexturedMesh()), "a mesh carrying UVs is recognised")
    ok(not rt.has_uv(_FakeTexturedMesh(uv=None)), "and one without them is too")

    # a multi-part scene is refused by name rather than silently repainting one part
    class _Scene:
        def __init__(self, n: int) -> None:
            self.geometry = {f"g{i}": _FakeTexturedMesh() for i in range(n)}

    ok(rt.as_mesh(_Scene(1)) is not None, "a single-geometry scene unwraps")
    try:
        rt.as_mesh(_Scene(3))
        ok(False, "a 3-part scene must be refused")
    except AdapterError as err:
        ok(err.code == "bad-input", f"bad-input, got {err.code}")
        ok("found 3" in err.message, f"names the count: {err.message}")


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
            test_non_image_input_ends_terminally(port, tmp)
            test_unknown_adapter(port)
            test_bad_requests(port)
            test_single_flight(port, tmp)
            test_pose_checks()
            test_fixture_gen_determinism(tmp)
            test_fixture_gen_validation(tmp)
            test_texture_substage(tmp)
            test_fixture_gen_over_http(port, tmp)
            test_rembg_model_missing(tmp)
            test_scene_geometry(tmp)
            test_trellis2_collapse_detector()
            test_trellis2_metal_gate()
            test_trellis2_retry_ladder()
            test_trellis2_params_and_input(tmp)
            test_trellis2_code_dir(tmp)
            test_trellis2_rembg_is_refused()
            test_trellis2_registered()
            test_retexture_collapse_and_ladder()
            test_retexture_frame_guard()
            test_retexture_params_and_uv()
            test_unirig_params()
            test_unirig_validation()
            test_unirig_naming()
            test_unirig_environment(tmp)
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
