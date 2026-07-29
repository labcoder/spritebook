"""Derive `rig --edits` hints from a deform report: joint -> its flesh centroid.

The deform check names torn joints but not where they should BE. This computes
a principled target for each excessive-stretch joint: the centroid of the
vertices it influences above the weight floor - "put the joint in the middle of
the flesh it drives" - and emits the delta as a patch.json for
`rig --edits <file> --rerun-with-hints`.

Measured on bulma (HINTS-REPORT.md): the hint's effect tracks its size. The
169 mm clavicle_r relocation cut its torn band 6x (1.70% -> 0.27%, against
+/-0.1pp reroll noise); the 21 mm spine_02 nudge moved it 1.46% -> 1.33%, still
flagged. A joint already sitting near its centroid has nothing to gain here.

READS ARE STRIDE-AWARE. The rigged glb interleaves attributes (byteStride 52),
and a contiguous read returns garbage that LOOKS like data - an earlier probe
"found" weight sums of -1.7..3.4 and body-wide influence smears that were
entirely a strideless read. Sums are exactly 1.0.

  uv run --project sidecar python spikes/trellis2/hint_from_report.py <rig-dir> [out.json]
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np

WEIGHT_FLOOR = 0.05
COMP = {5121: (np.uint8, 1), 5123: (np.uint16, 2), 5125: (np.uint32, 4), 5126: (np.float32, 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path: Path):
    raw = path.read_bytes()
    jlen = struct.unpack("<I", raw[12:16])[0]
    doc = json.loads(raw[20:20 + jlen])
    blen = struct.unpack("<I", raw[20 + jlen:24 + jlen])[0]
    return doc, raw[28 + jlen:28 + jlen + blen]


def accessor(doc, bin_, idx):
    a = doc["accessors"][idx]
    bv = doc["bufferViews"][a["bufferView"]]
    dt, isz = COMP[a["componentType"]]
    k = NCOMP[a["type"]]
    base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or k * isz
    out = np.empty((a["count"], k), dtype=dt)
    for j in range(a["count"]):
        out[j] = np.frombuffer(bin_, dt, k, base + j * stride)
    arr = out.astype(np.float64)
    return arr / np.iinfo(dt).max if a.get("normalized") else arr


def main() -> int:
    rig_dir = Path(sys.argv[1])
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else rig_dir / "hints-patch.json"

    report = json.loads((rig_dir / "deform-report.json").read_text())
    torn = [j["joint"] for j in report["joints"] if "excessive-stretch" in j["flags"]]
    skel = json.loads((rig_dir / "rig.json").read_text())
    head = {j["name"]: np.asarray(j["head"], dtype=np.float64) for j in skel["joints"]}

    doc, bin_ = read_glb(rig_dir / "rigged.glb")
    prim = doc["meshes"][0]["primitives"][0]
    pos = accessor(doc, bin_, prim["attributes"]["POSITION"])
    ji = accessor(doc, bin_, prim["attributes"]["JOINTS_0"]).astype(np.int64)
    wt = accessor(doc, bin_, prim["attributes"]["WEIGHTS_0"])
    names = [doc["nodes"][j].get("name") for j in doc["skins"][0]["joints"]]

    edits = []
    print(f"{'joint':16} {'influence':>9} {'|delta|':>9}")
    for t in torn:
        if t not in head or t not in names:
            continue
        si = names.index(t)
        m = ((wt > WEIGHT_FLOOR) & (ji == si)).any(axis=1)
        if not m.any():
            continue
        delta = pos[m].mean(axis=0) - head[t]
        print(f"{t:16} {int(m.sum()):9,} {np.linalg.norm(delta) * 1000:7.1f} mm")
        edits.append({
            "joint": t,
            "delta": [round(float(v), 6) for v in delta],
            "mirrored": False,
        })

    out_path.write_text(json.dumps({"edits": edits}, indent=2) + "\n", encoding="utf-8")
    print(f"\nwrote {out_path} ({len(edits)} edits)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
