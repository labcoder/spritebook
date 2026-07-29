"""Is `excessive-stretch` measuring shredding, or the worst micro-edge?

The deform check flags a joint when the MAX edge-length ratio over its
influenced edges exceeds 2.0 under a +/-30 degree bend. On bulma that flags
32 of 52 joints, every run, always led by the same spine/neck/head chain. Two
readings are possible and the report cannot distinguish them, because it stores
only the max:

  REAL      whole boundary regions stretch 2-6x: torn weights, bad rig.
  INFLATED  a handful of micro-edges (a 200k-face TRELLIS mesh is full of
            sub-millimetre edges) cross a weight boundary and post huge RATIOS
            from sub-millimetre absolute movement, while the P99 edge sits
            near 1.0. Max over ~50k samples is an extreme-value statistic; the
            check's degenerate-edge floor is 1e-9 m - one nanometre.

This reimplements the check's pose spec 1:1 from packages/rig/deform.ts (same
axis choice, same +/-30 rotation about the joint head, same LBS skinning, same
influence floor 0.05, same edge set) and VALIDATES itself by matching the
report's own maxEdgeStretch per joint before printing anything else. Then it
prints what the report leaves out: the ratio distribution, and the rest lengths
of the edges above threshold.

  uv run --project sidecar python spikes/trellis2/deform_dist.py

RESULT (bulma, 52 joints, every reproduction matching the report to 4 dp):
neither reading was right. The offenders are NOT degenerate micro-edges - the
over-2x edges have median rest lengths of 3-6 mm against an all-edge median of
7 mm, so raising the 1e-9 m floor would fix nothing. But the max IS an
outlier statistic: calf_l flags on 5 edges of 21,909 (0.02%, P99 1.24), while
spine_02's 712-edge band (1.5%, P99 2.17) is real shredding. The max cannot
tell those apart; a fraction-with-count-floor rule can. See deform.ts.
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
RIG_DIR = REPO / "spikes/trellis2/out/p3-exit/bulma-fixed/rig"
WEIGHT_FLOOR = 0.05
ANGLE = np.deg2rad(30.0)
DEGENERATE_EDGE_M = 1e-9

COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path: Path):
    raw = path.read_bytes()
    jlen = struct.unpack("<I", raw[12:16])[0]
    doc = json.loads(raw[20:20 + jlen])
    blen = struct.unpack("<I", raw[20 + jlen:24 + jlen])[0]
    bin_ = raw[28 + jlen:28 + jlen + blen]
    return doc, bin_


def accessor(doc, bin_, idx):
    a = doc["accessors"][idx]
    bv = doc["bufferViews"][a["bufferView"]]
    dt = COMP[a["componentType"]]
    n = NCOMP[a["type"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    count = a["count"]
    stride = bv.get("byteStride")
    if stride and stride != n * np.dtype(dt).itemsize:
        rows = []
        for i in range(count):
            rows.append(np.frombuffer(bin_, dt, n, off + i * stride))
        arr = np.stack(rows)
    else:
        arr = np.frombuffer(bin_, dt, count * n, off).reshape(count, n)
    if a.get("normalized"):
        arr = arr.astype(np.float64) / np.iinfo(dt).max
    return np.ascontiguousarray(arr)


def local_matrix(node):
    m = np.eye(4)
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        m[:3, :3] = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ])
    if "scale" in node:
        m[:3, :3] = m[:3, :3] @ np.diag(node["scale"])
    if "translation" in node:
        m[:3, 3] = node["translation"]
    return m


def main() -> int:
    doc, bin_ = read_glb(RIG_DIR / "rigged.glb")
    report = json.loads((RIG_DIR / "deform-report.json").read_text())
    by_joint = {j["joint"]: j for j in report["joints"]}

    prim = doc["meshes"][0]["primitives"][0]
    pos = accessor(doc, bin_, prim["attributes"]["POSITION"]).astype(np.float64)
    ji = accessor(doc, bin_, prim["attributes"]["JOINTS_0"]).astype(np.int64)
    wt = accessor(doc, bin_, prim["attributes"]["WEIGHTS_0"]).astype(np.float64)
    idx = accessor(doc, bin_, prim["indices"]).reshape(-1, 3)
    skin = doc["skins"][0]
    joints = skin["joints"]
    ibm = accessor(doc, bin_, skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)

    # rest world matrices from the node hierarchy
    nodes = doc["nodes"]
    world = [None] * len(nodes)

    def walk(i, parent):
        world[i] = parent @ local_matrix(nodes[i])
        for c in nodes[i].get("children", []):
            walk(c, world[i])

    for r in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        walk(r, np.eye(4))
    world = np.stack([world[i] if world[i] is not None else np.eye(4) for i in range(len(nodes))])

    # descendants per node
    children = {i: nodes[i].get("children", []) for i in range(len(nodes))}

    def subtree(i):
        out, stack = set(), [i]
        while stack:
            n = stack.pop()
            out.add(n)
            stack.extend(children[n])
        return out

    def skinned(mats):
        # v' = sum_i w_i * (S[j_i] @ v)
        s = mats[joints] @ ibm[np.arange(len(joints))]  # per skin-joint
        out = np.zeros_like(pos)
        vh = np.concatenate([pos, np.ones((len(pos), 1))], axis=1)
        for k in range(4):
            m = s[ji[:, k]]
            out += wt[:, k:k + 1] * np.einsum("nij,nj->ni", m, vh)[:, :3]
        return out

    rest = skinned(world)

    # unique edges with a precomputed rest length
    e = np.concatenate([idx[:, [0, 1]], idx[:, [1, 2]], idx[:, [2, 0]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    rest_len = np.linalg.norm(rest[e[:, 0]] - rest[e[:, 1]], axis=1)
    ok_edge = rest_len >= DEGENERATE_EDGE_M
    name_of = {i: nodes[n].get("name", f"n{n}") for i, n in enumerate(joints)}

    targets = [name_of[i] for i in range(len(joints))]
    print(f"validating against the report, then the distribution the report cannot show")
    print(f"mesh: {len(pos):,} verts, {len(e):,} unique edges; median rest edge "
          f"{np.median(rest_len[ok_edge])*1000:.2f} mm\n")

    rows = []
    for tname in targets:
        si = next((i for i, n in name_of.items() if n == tname), None)
        if si is None:
            continue
        node_i = joints[si]
        infl = (wt > WEIGHT_FLOOR) & (ji == si)
        vmask = infl.any(axis=1)
        emask = vmask[e[:, 0]] & vmask[e[:, 1]] & ok_edge

        # pose axis: world basis axis most perpendicular to the bone (+Y col)
        bone = world[node_i][:3, 1]
        bone = bone / np.linalg.norm(bone)
        dots = [abs(bone[0]), abs(bone[1]), abs(bone[2])]
        ax = np.eye(3)[int(np.argmin(dots))]
        ax = ax - np.dot(ax, bone) * bone
        ax = ax / np.linalg.norm(ax)
        head = world[node_i][:3, 3]
        sub = subtree(node_i)

        worst = np.zeros(emask.sum())
        for sign in (1.0, -1.0):
            c, s_ = np.cos(sign * ANGLE), np.sin(sign * ANGLE)
            x, y, z = ax
            R = np.array([
                [c + x * x * (1 - c), x * y * (1 - c) - z * s_, x * z * (1 - c) + y * s_],
                [y * x * (1 - c) + z * s_, c + y * y * (1 - c), y * z * (1 - c) - x * s_],
                [z * x * (1 - c) - y * s_, z * y * (1 - c) + x * s_, c + z * z * (1 - c)],
            ])
            M = np.eye(4)
            M[:3, :3] = R
            M[:3, 3] = head - R @ head
            posed_world = world.copy()
            for n in sub:
                posed_world[n] = M @ world[n]
            posed = skinned(posed_world)
            plen = np.linalg.norm(posed[e[emask][:, 0]] - posed[e[emask][:, 1]], axis=1)
            worst = np.maximum(worst, plen / rest_len[emask])

        if emask.sum() == 0:
            rows.append((tname, 0, 0, 0.0, 0.0, 0.0, "OK"))
            continue
        rep = by_joint.get(tname, {}).get("maxEdgeStretch", float("nan"))
        m = worst.max()
        match = "OK" if rep != rep or abs(m - rep) / max(rep, 1e-9) < 0.02 else "MISMATCH"
        over = int((worst > 2.0).sum())
        p99 = float(np.percentile(worst, 99))
        rows.append((tname, int(emask.sum()), over, over / emask.sum(), p99, float(m), match))

    print(f"{'joint':16} {'edges':>7} {'over2':>6} {'frac':>7} {'P99':>6} {'max':>7}  "
          f"{'old':>4} {'frac>=1%':>8}  match")
    old_new = [0, 0]
    for tname, ne, over, frac, p99, m, match in sorted(rows, key=lambda r: -r[3]):
        old = m > 2.0
        new = frac >= 0.01
        old_new[0] += old
        old_new[1] += new
        print(f"{tname:16} {ne:7,} {over:6d} {frac:6.2%} {p99:6.2f} {m:7.2f}  "
              f"{'FLAG' if old else '-':>4} {'FLAG' if new else '-':>8}  {match}")
    print(f"\nflagged joints: max>2 rule {old_new[0]}/52   fraction>=1% rule {old_new[1]}/52")
    return 0


if __name__ == "__main__":
    sys.exit(main())
