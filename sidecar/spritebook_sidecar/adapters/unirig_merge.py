"""UniRig merge stage — executed INSIDE the UniRig virtualenv, no bpy, no GPU.

Upstream's merge (``src/inference/merge.py``) drives bpy to build an armature
and write a RIGGED file. SpriteBook must not do that: the rig that lands in the
manifest is applied to glTF by CORE, and the licence boundary is drawn at that
data seam (``packages/schema/rig.ts``). So this stage does the same geometry
work with numpy and scipy only, and emits ARRAYS.

It runs in the UniRig env rather than the sidecar's because it reads UniRig's
npz files and wants ``scipy.spatial.cKDTree``; the sidecar env stays light.
Nothing here imports torch, lightning or bpy, so it is fast and cannot inherit
the bpy teardown crash.

## The three spaces, and how they are reconciled

    normalized      what the model predicted in: the input npz's vertices+joints
                    bbox mapped into [-1, 1] (UniRig's AugmentAffine)
    unirig          the skeleton npz's own coordinates (a bpy/FBX round trip of
                    the source mesh: Z-up, arbitrary uniform scale)
    canonical       the mesh core will apply the rig to: the glb's own space
                    (D-012 +Y up, metres), read by the sidecar

`normalized -> unirig` is recovered EXACTLY: the model's joints and the npz's
joints are the same joints, so a single (scale, offset) fit over them inverts
the normalization — and its residual doubles as proof that the joint ORDER of
the skin prediction still matches the skeleton npz. A blown residual means an
assumption broke, and the stage says so instead of producing a plausible rig in
the wrong place.

`unirig -> canonical` is a bbox-anchored similarity over a SHORT LIST of
axis maps (identity and the two Y-up/Z-up conversions). Upstream brute-forces
all 48 axis permutations and sign flips, which on a near-symmetric character can
land on a MIRROR and silently swap left and right (P0-T4 catalog item 6). All
three candidates here are proper rotations, and if none of them fits the mesh to
within a small fraction of its bbox diagonal the stage fails loudly.

## Weight transfer

``reskin`` mirrors ``src/system/skin.py:reskin`` (UniRig, MIT) — median of the 7
nearest sampled points, then one diffusion pass along mesh edges from hotter to
cooler joints — targeted directly at the CANONICAL vertices instead of at the
decimated intermediate, so there is one resampling hop rather than two. The one
deliberate difference is the final normalization: upstream divides by the row
sum unguarded, which is exactly the NaN factory P0-T4 catalogued (item 5). Here
zero-weight rows are left at zero and COUNTED; the caller decides what to say
about them.
"""

from __future__ import annotations

import argparse
import json
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

#: glTF's JOINTS_0/WEIGHTS_0 hold four influences per vertex.
INFLUENCES = 4
#: reskin tuning, from UniRig's own quick-inference call site
NEAREST_SAMPLES = 7
DIFFUSION_ALPHA = 2.0
DIFFUSION_STEPS = 1
WEIGHT_FLOOR = 0.03
#: rows processed per block, so a 200k-vertex character cannot blow up memory
VERTEX_BLOCK = 16384
EDGE_BLOCK = 262144

#: right-handed axis maps tried when fitting UniRig space onto the glb's.
AXIS_MAPS: dict[str, np.ndarray] = {
    "identity": np.eye(3),
    # Blender world (Z-up) -> glTF (Y-up): (x, y, z) -> (x, z, -y)
    "blender-to-gltf": np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]]),
    # the inverse, in case the round trip already converted
    "gltf-to-blender": np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]]),
}
#: mean nearest-neighbour distance allowed between the fitted UniRig mesh and
#: the canonical mesh, as a fraction of the canonical bbox diagonal
MAX_ALIGN_FRACTION = 0.02
#: max per-joint error allowed when inverting the model's [-1, 1] normalization,
#: as a fraction of the skeleton's own extent
MAX_JOINT_FIT_FRACTION = 0.01


class MergeError(RuntimeError):
    """Raised with an operator-readable reason; the caller turns it into an
    AdapterError so the message reaches the user unchanged."""


def _unpack(value: Any) -> Any:
    """np.load gives 0-d object arrays back for lists; unwrap them."""
    if isinstance(value, np.ndarray) and value.ndim == 0:
        return value[()]
    return value


def load_skeleton(path: str) -> dict[str, Any]:
    """joints / tails / parents / names / vertices out of a UniRig raw_data npz."""
    data = np.load(path, allow_pickle=True)
    missing = [k for k in ("vertices", "joints", "parents") if k not in data]
    if missing:
        raise MergeError(f"{path} is missing {', '.join(missing)}; the skeleton stage wrote no rig")
    joints = np.asarray(_unpack(data["joints"]), dtype=np.float64)
    vertices = np.asarray(_unpack(data["vertices"]), dtype=np.float64)
    raw_parents = list(_unpack(data["parents"]))
    parents = np.array([-1 if p is None else int(p) for p in raw_parents], dtype=np.int64)
    tails = _unpack(data["tails"]) if "tails" in data else None
    tails = np.asarray(tails, dtype=np.float64) if tails is not None else joints.copy()
    names_raw = _unpack(data["names"]) if "names" in data else None
    if names_raw is None:
        names = [f"bone_{i}" for i in range(joints.shape[0])]
    else:
        names = [str(n) for n in list(names_raw)]
    if len(names) != joints.shape[0] or parents.shape[0] != joints.shape[0]:
        raise MergeError(
            f"{path} is internally inconsistent: {joints.shape[0]} joints, "
            f"{len(names)} names, {parents.shape[0]} parents"
        )
    return {
        "joints": joints,
        "tails": tails,
        "parents": parents,
        "names": names,
        "vertices": vertices,
    }


def fit_scale_offset(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, float]:
    """Least-squares uniform scale + translation taking ``src`` onto ``dst``.

    Used to invert UniRig's [-1, 1] normalization from the two copies of the
    SAME joint set. Returns (scale, offset, max residual) — the residual is the
    evidence, not a formality: it is the only thing that would notice if the
    prediction's joint order stopped matching the skeleton npz's.
    """
    if src.shape != dst.shape or src.shape[0] < 2:
        raise MergeError(
            f"cannot fit {src.shape} onto {dst.shape}: the skin prediction and the skeleton "
            "npz disagree about how many joints there are"
        )
    src_mean = src.mean(axis=0)
    dst_mean = dst.mean(axis=0)
    sc = src - src_mean
    dc = dst - dst_mean
    denom = float((sc * sc).sum())
    if denom <= 0.0:
        raise MergeError("all predicted joints are at the same point; there is no skeleton")
    scale = float((sc * dc).sum() / denom)
    offset = dst_mean - scale * src_mean
    residual = float(np.abs(src * scale + offset - dst).max())
    return scale, offset, residual


def fit_to_canonical(
    unirig_vertices: np.ndarray, canonical_vertices: np.ndarray
) -> tuple[str, np.ndarray, float, np.ndarray, float, float]:
    """Best (axis map, scale, offset) taking UniRig space onto the glb's.

    Returns (name, R, scale, offset, mean residual, max residual).
    """
    c_min = canonical_vertices.min(axis=0)
    c_max = canonical_vertices.max(axis=0)
    diag = float(np.linalg.norm(c_max - c_min))
    if diag <= 0.0:
        raise MergeError("the canonical mesh has zero extent")
    tree = cKDTree(canonical_vertices)

    best: tuple[float, str, np.ndarray, float, np.ndarray, float] | None = None
    for name, rot in AXIS_MAPS.items():
        posed = unirig_vertices @ rot.T
        p_min = posed.min(axis=0)
        p_max = posed.max(axis=0)
        extent = float(np.max(p_max - p_min))
        if extent <= 0.0:
            continue
        scale = float(np.max(c_max - c_min)) / extent
        offset = (c_max + c_min) / 2.0 - scale * (p_max + p_min) / 2.0
        # query the CANONICAL tree with the fitted UniRig points: the UniRig
        # mesh is a decimation of the same surface, so every one of its points
        # should sit on it
        dist, _ = tree.query(posed * scale + offset)
        mean_d = float(dist.mean())
        if best is None or mean_d < best[0]:
            best = (mean_d, name, rot, scale, offset, float(dist.max()))
    if best is None:
        raise MergeError("the UniRig mesh has zero extent on every axis")
    mean_d, name, rot, scale, offset, max_d = best
    if mean_d > MAX_ALIGN_FRACTION * diag:
        raise MergeError(
            f"could not align UniRig's mesh with the input: best fit '{name}' leaves a mean "
            f"vertex distance of {mean_d:.4f} m ({mean_d / diag * 100:.1f}% of the "
            f"{diag:.3f} m bbox diagonal, limit {MAX_ALIGN_FRACTION * 100:.0f}%). The rig would "
            "be in the wrong place, so it is refused rather than written."
        )
    return name, rot, scale, offset, mean_d, max_d


def reskin(
    sampled_vertices: np.ndarray,
    sampled_skin: np.ndarray,
    vertices: np.ndarray,
    triangles: np.ndarray,
    parents: np.ndarray,
) -> np.ndarray:
    """Per-vertex weights for ``vertices`` from the model's sampled prediction.

    Mirrors UniRig's ``reskin`` (MIT): median over the nearest sampled points,
    then one hotter-to-cooler diffusion pass along mesh edges, accumulated up
    the joint chain so a child's influence bleeds into its parent rather than
    across the body. Zero-weight rows survive as zeros (see module docstring).
    """
    n_vertices = int(vertices.shape[0])
    n_joints = int(sampled_skin.shape[1])
    k = min(NEAREST_SAMPLES, int(sampled_vertices.shape[0]))
    tree = cKDTree(sampled_vertices)
    skin = np.zeros((n_vertices, n_joints), dtype=np.float32)
    for start in range(0, n_vertices, VERTEX_BLOCK):
        block = vertices[start : start + VERTEX_BLOCK]
        _, nearest = tree.query(block, k=k)
        nearest = np.asarray(nearest).reshape(block.shape[0], -1)
        skin[start : start + VERTEX_BLOCK] = np.median(sampled_skin[nearest], axis=1)

    edges = np.concatenate(
        [triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]], axis=0
    )
    edges = np.concatenate([edges, edges[:, [1, 0]]], axis=0)
    edge_len = np.linalg.norm(vertices[edges[:, 1]] - vertices[edges[:, 0]], axis=1, keepdims=True)
    co_all = np.exp(-edge_len * DIFFUSION_ALPHA).astype(np.float32)

    # parents[i] < i is guaranteed upstream (RawData.check), so accumulating up
    # the chain is a single reversed sweep and restoring it a forward one.
    for _ in range(DIFFUSION_STEPS):
        acc = skin.copy()
        for i in range(n_joints - 1, -1, -1):
            p = int(parents[i])
            if p >= 0:
                acc[:, p] += acc[:, i]
        neighbor = np.zeros_like(acc)
        neighbor_co = np.zeros((n_vertices, n_joints), dtype=np.float32)
        for start in range(0, edges.shape[0], EDGE_BLOCK):
            e = edges[start : start + EDGE_BLOCK]
            co = co_all[start : start + EDGE_BLOCK, 0]
            src = acc[e[:, 0]]
            mask = acc[e[:, 1]] < src
            target = e[:, 1]
            # a scatter-add per joint column: np.bincount is C-speed where
            # np.add.at on a (E, J) block is not
            for j in range(n_joints):
                sel = mask[:, j]
                neighbor[:, j] += np.bincount(
                    target, weights=src[:, j] * co * sel, minlength=n_vertices
                ).astype(np.float32)
                neighbor_co[:, j] += np.bincount(
                    target, weights=co * sel, minlength=n_vertices
                ).astype(np.float32)
        acc = (acc + neighbor) / (1.0 + neighbor_co)
        for i in range(n_joints):
            p = int(parents[i])
            if p >= 0:
                acc[:, p] -= acc[:, i]
        total = acc.sum(axis=-1, keepdims=True)
        live = np.abs(total) > 0
        skin = np.where(live, acc / np.where(live, total, 1.0), 0.0).astype(np.float32)

    # upstream's "avoid 0-skin" pass: drop dust weights, but only for rows that
    # have something real left afterwards
    strong = (skin >= WEIGHT_FLOOR).any(axis=-1, keepdims=True)
    skin = np.where((skin < WEIGHT_FLOOR) & strong, 0.0, skin)
    return skin


def top_influences(skin: np.ndarray, k: int = INFLUENCES) -> tuple[np.ndarray, np.ndarray]:
    """The k strongest joints per vertex, values UNCHANGED.

    No normalization and no NaN scrubbing happen here: the caller's census has
    to see what the model actually produced (sidecar-vram law).
    """
    n_joints = int(skin.shape[1])
    take = min(k, n_joints)
    # rank on a finite copy so NaN columns sort LAST, but read the values back
    # out of the ORIGINAL array so a NaN still reaches the caller's census
    ranked = np.where(np.isfinite(skin), skin, -np.inf)
    order = np.argsort(-ranked, axis=1, kind="stable")[:, :take]
    values = np.take_along_axis(skin, order, axis=1)
    if take < k:  # fewer joints than influence slots: pad with empty slots
        pad = k - take
        order = np.concatenate([order, np.zeros((order.shape[0], pad), dtype=order.dtype)], axis=1)
        values = np.concatenate(
            [values, np.zeros((values.shape[0], pad), dtype=values.dtype)], axis=1
        )
    return order.astype(np.int64), values.astype(np.float32)


def nonfinite(arr: np.ndarray) -> int:
    a = np.asarray(arr, dtype=np.float64)
    return int(np.isnan(a).sum() + np.isinf(a).sum())


def run_align(args: argparse.Namespace) -> dict[str, Any]:
    """Put the predicted skeleton in the canonical mesh's space, and stop.

    The caller needs the joints in glb space BEFORE the skin stage runs: that is
    where the semantic-naming pass happens, and where a `--rerun-with-hints`
    marker (an absolute position in mesh space) has to be resolved. Emitting the
    fit itself lets the caller map a hint back into UniRig space without
    needing scipy in the sidecar's own environment.
    """
    skel = load_skeleton(args.skeleton_npz)
    mesh = np.load(args.mesh_npz)
    canonical = np.asarray(mesh["positions"], dtype=np.float64)
    axis_name, rot, scale, offset, mean_d, max_d = fit_to_canonical(skel["vertices"], canonical)
    np.savez(
        args.out,
        joints=(skel["joints"] @ rot.T) * scale + offset,
        tails=(skel["tails"] @ rot.T) * scale + offset,
        parents=skel["parents"],
        names=np.array(skel["names"], dtype=np.str_),
        rotation=rot,
        scale=np.float64(scale),
        offset=offset,
    )
    return {
        "axisMap": axis_name,
        "unirigToCanonicalScale": scale,
        "alignMeanDistance": mean_d,
        "alignMaxDistance": max_d,
        "jointCount": int(skel["joints"].shape[0]),
        "vertexCount": int(canonical.shape[0]),
    }


def run_weights(args: argparse.Namespace) -> dict[str, Any]:
    skel = load_skeleton(args.skeleton_npz)
    skin_data = np.load(args.skin_npz, allow_pickle=True)
    for key in ("skin", "vertices", "joints"):
        if key not in skin_data:
            raise MergeError(f"{args.skin_npz} has no '{key}'; the skin stage wrote nothing usable")
    sampled_skin = np.asarray(_unpack(skin_data["skin"]), dtype=np.float32)
    sampled_vertices = np.asarray(_unpack(skin_data["vertices"]), dtype=np.float64)
    predicted_joints = np.asarray(_unpack(skin_data["joints"]), dtype=np.float64)

    mesh = np.load(args.mesh_npz)
    canonical = np.asarray(mesh["positions"], dtype=np.float64)
    triangles = np.asarray(mesh["triangles"], dtype=np.int64)

    # census on the RAW model output, before anything touches it
    nf_weights = nonfinite(sampled_skin)
    nf_joints = nonfinite(predicted_joints) + nonfinite(skel["joints"]) + nonfinite(skel["tails"])

    if sampled_skin.shape[0] != sampled_vertices.shape[0]:
        raise MergeError(
            f"skin prediction has {sampled_skin.shape[0]} rows for "
            f"{sampled_vertices.shape[0]} sampled points"
        )
    if sampled_skin.shape[1] != skel["joints"].shape[0]:
        raise MergeError(
            f"skin prediction covers {sampled_skin.shape[1]} joints but the skeleton has "
            f"{skel['joints'].shape[0]}"
        )

    # 1. normalized -> unirig, inverted from the two copies of the joint set
    scale_n, offset_n, joint_residual = fit_scale_offset(predicted_joints, skel["joints"])
    extent = float(np.max(skel["joints"].max(axis=0) - skel["joints"].min(axis=0)))
    if not np.isfinite(joint_residual) or joint_residual > MAX_JOINT_FIT_FRACTION * max(extent, 1e-9):
        raise MergeError(
            f"the skin stage's joints do not match the skeleton stage's: inverting the model's "
            f"normalization leaves {joint_residual:.6g} of error over a {extent:.6g} extent. "
            "The two stages disagree about joint order or the prediction is non-finite "
            f"({nf_weights} non-finite weights, {nf_joints} non-finite joint coordinates)."
        )
    sampled_unirig = sampled_vertices * scale_n + offset_n

    # 2. unirig -> canonical
    axis_name, rot, scale_c, offset_c, mean_d, max_d = fit_to_canonical(
        skel["vertices"], canonical
    )

    def to_canonical(points: np.ndarray) -> np.ndarray:
        return (points @ rot.T) * scale_c + offset_c

    joints_c = to_canonical(skel["joints"])
    tails_c = to_canonical(skel["tails"])
    sampled_c = to_canonical(sampled_unirig)

    # 3. weights, straight onto the canonical vertices
    dense = reskin(sampled_c, sampled_skin, canonical, triangles, skel["parents"])
    row_sums = dense.astype(np.float64).sum(axis=1)
    indices, weights = top_influences(dense)

    np.savez(
        args.out,
        joints=joints_c,
        tails=tails_c,
        parents=skel["parents"],
        names=np.array(skel["names"], dtype=np.str_),
        indices=indices,
        weights=weights,
        rowSums=row_sums,
        nonFiniteWeights=np.int64(nf_weights),
        nonFiniteJoints=np.int64(nf_joints),
        vertexCount=np.int64(canonical.shape[0]),
        jointCount=np.int64(joints_c.shape[0]),
    )
    return {
        "axisMap": axis_name,
        "unirigToCanonicalScale": scale_c,
        "normalizedToUnirigScale": scale_n,
        "jointFitResidual": joint_residual,
        "alignMeanDistance": mean_d,
        "alignMaxDistance": max_d,
        "nonFiniteWeights": nf_weights,
        "nonFiniteJoints": nf_joints,
        "vertexCount": int(canonical.shape[0]),
        "jointCount": int(joints_c.shape[0]),
        "sampledPoints": int(sampled_vertices.shape[0]),
    }


#: the caller parses the line after this marker; everything else on stdout is
#: upstream's own chatter and is only ever read by a human debugging a run
RESULT_MARKER = "UNIRIG-MERGE-RESULT"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["align", "weights"], required=True)
    ap.add_argument("--skeleton-npz", required=True)
    ap.add_argument("--mesh-npz", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--skin-npz")
    args = ap.parse_args()
    if args.mode == "weights" and not args.skin_npz:
        raise MergeError("--skin-npz is required in weights mode")
    stats = run_align(args) if args.mode == "align" else run_weights(args)
    print(f"{RESULT_MARKER} {json.dumps(stats)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MergeError as exc:
        print(f"MERGE-ERROR {exc}")
        raise SystemExit(3) from exc
