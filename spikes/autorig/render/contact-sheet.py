#!/usr/bin/env python
"""P0-T4 spike: render a contact sheet from a rigged (optionally animated) glb.

Usage (inside the spike's Python env with bpy installed):
    python contact-sheet.py --input rigged.glb --output out/sheet.png --frames 8 [--clip Walk]

Also works directly against the downloaded clip libraries for a smoke test before any
UniRig output exists (import of an 87-clip library takes a while):
    python contact-sheet.py --input ../anim/human-base-animations.glb \
        --output out/walk.png --frames 8 --clip Walk

Grid layout: N columns (sampled frames, evenly spaced across the clip, first and last
included) x 3 rows:
    row 1  full character, 3/4 front view (camera fixed across frames, so root motion reads)
    row 2  close-up on the upper body / shoulders (camera follows the joints per frame)
    row 3  close-up on the pelvis / hips (camera follows per frame)
The task brief said "a second row of close-ups (shoulders + pelvis)"; that is split into two
rows here so every sampled frame is visible at both crops - same information, rectangular grid.
If the glb has no animation, a single bind-pose column is rendered instead.

Renders each cell to a temp PNG (Eevee by default, --engine workbench as fallback), then
stitches with Pillow. Dependencies (see requirements.txt next to this file): bpy==4.2.*, pillow.

UNTESTED ASSUMPTIONS (bpy could not be run on the authoring machine - verify on first run):
 1. bpy 4.2 pip wheel can render Eevee headless on the lead's machine (RTX 3090). If Eevee
    errors or produces black frames, rerun with --engine workbench (CPU, always works, flat
    studio look ignores scene lights).
 2. Engine identifier in 4.2 is 'BLENDER_EEVEE_NEXT' (legacy 'BLENDER_EEVEE' removed in 4.2,
    re-renamed back in 4.5). The script tries NEXT first, then the legacy id.
 3. The glTF importer creates one Action per clip, named after the clip (deduped names get
    numeric suffixes), converts keyframe seconds to frames at the scene fps, and
    `action.frame_range` reflects the clip span. Frame sampling trusts `action.frame_range`.
 4. Blender 4.2 actions have no slot system (that landed in 4.4) - plain
    `armature.animation_data.action = action` binds bone curves.
 5. Orientation: glTF character faces +Z (repo law); the importer's axis conversion makes it
    face -Y in Blender world space, so a camera at azimuth 45 deg on the -Y side is a 3/4
    FRONT view. If sheets show a 3/4 BACK view, flip AZIMUTH_DEG sign.
 6. `pose_bone.head` is the posed head position in armature object space;
    `armature.matrix_world @ pose_bone.head` is world space (after view_layer.update()).
 7. Shoulder/pelvis targets come from bone-name heuristics (clavicle/shoulder/upperarm,
    pelvis/hips - covers M2M/UE, Mixamo, Rigify). Unknown conventions (bare UniRig AR bones)
    fall back to bind-bbox height fractions (shoulders 0.80*H, pelvis 0.52*H) with a warning.
 8. Single-character files assumed: the armature with the most bound mesh vertices is used.
 9. The glTF importer parks multi-clip files as NLA tracks/strips; whether those evaluate by
    default is version-dependent, so ALL NLA tracks on all objects are muted and non-armature
    active actions cleared before sampling - only the chosen clip should pose the character.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import tempfile

try:
    import bpy
    from mathutils import Vector
except ImportError as exc:  # clear error instead of a stack trace
    sys.exit(f"error: bpy is not importable ({exc}). Install with: pip install bpy==4.2.*")

# ---------------------------------------------------------------------------- tunables
AZIMUTH_DEG = 45.0        # 3/4 view: 0 = straight front (-Y side), positive rotates toward +X
ELEV_FULL_DEG = 12.0      # camera elevation for the full-body row
ELEV_CLOSE_DEG = 5.0      # flatter angle for the close-up rows
MARGIN_FULL = 1.25        # bounding-sphere framing margin, full body
SHOULDER_RADIUS_FRAC = 0.24   # close-up crop radius as a fraction of character height
PELVIS_RADIUS_FRAC = 0.20
SHOULDER_HEIGHT_FRAC = 0.80   # bbox-fraction fallbacks when bone names are unrecognized
PELVIS_HEIGHT_FRAC = 0.52
SHOULDER_NAME_HINTS = ("clavicle", "shoulder", "upperarm", "upper_arm", "leftarm", "rightarm")
PELVIS_NAME_HINTS = ("pelvis", "hips", "hip")
BACKGROUND_GRAY = 0.22    # sheet background (cells render with transparent film)
LABEL_STRIP_PX = 18


def parse_args() -> argparse.Namespace:
    # Support both `python contact-sheet.py ...` and `blender -b -P contact-sheet.py -- ...`
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser(description="Render a rig/animation contact sheet from a glb.")
    p.add_argument("--input", required=True, help="rigged .glb/.gltf to render")
    p.add_argument("--output", required=True, help="output sheet .png path")
    p.add_argument("--frames", type=int, default=8, help="frames sampled across the clip (default 8)")
    p.add_argument("--clip", default=None, help="animation clip (action) name; default: only/first clip")
    p.add_argument("--cell-size", type=int, default=448, help="square cell resolution in px (default 448)")
    p.add_argument("--engine", choices=("eevee", "workbench"), default="eevee")
    args = p.parse_args(argv)
    if args.frames < 1:
        p.error("--frames must be >= 1")
    return args


def die(msg: str, code: int = 2) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


# ---------------------------------------------------------------------------- scene setup

def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path: str) -> None:
    if not os.path.isfile(path):
        die(f"input file not found: {path}")
    try:
        bpy.ops.import_scene.gltf(filepath=path)
    except Exception as exc:
        die(f"glTF import failed for {path}: {exc}")


def find_character() -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    """Return (armature, skinned meshes bound to it). Picks the armature with the most
    bound vertices when there are several; errors clearly when there is none."""
    candidates: dict[bpy.types.Object, list[bpy.types.Object]] = {}
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        arm = next((m.object for m in obj.modifiers if m.type == "ARMATURE" and m.object), None)
        if arm is not None:
            candidates.setdefault(arm, []).append(obj)
    if not candidates:
        armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
        if armatures:
            die("armature found but no mesh is bound to it (armature-only file?) - "
                "contact sheet needs a skinned mesh to show deformation")
        die("no armature in the file - this script renders rigged characters only")
    armature = max(candidates, key=lambda a: sum(len(m.data.vertices) for m in candidates[a]))
    if len(candidates) > 1:
        print(f"warning: {len(candidates)} armatures found; using '{armature.name}' "
              f"(most bound vertices)")
    return armature, candidates[armature]


def pick_action(clip: str | None) -> bpy.types.Action | None:
    actions = sorted(bpy.data.actions, key=lambda a: a.name)
    if clip is not None:
        match = next((a for a in actions if a.name == clip), None)
        if match is None:
            available = ", ".join(a.name for a in actions) or "(none)"
            die(f"clip '{clip}' not found. Available clips: {available}")
        return match
    if not actions:
        return None
    if len(actions) > 1:
        print(f"note: {len(actions)} clips in file; defaulting to '{actions[0].name}'. "
              f"Pass --clip to choose. All clips: {', '.join(a.name for a in actions)}")
    return actions[0]


def isolate_action(armature: bpy.types.Object, action: bpy.types.Action) -> None:
    """Make `action` the only animation that evaluates (assumption 9)."""
    for obj in bpy.data.objects:
        ad = obj.animation_data
        if ad is None:
            continue
        for track in ad.nla_tracks:
            track.mute = True
        if obj is not armature:
            ad.action = None
    if armature.animation_data is None:
        armature.animation_data_create()
    armature.animation_data.action = action


def set_engine(engine: str) -> str:
    scene = bpy.context.scene
    if engine == "workbench":
        scene.render.engine = "BLENDER_WORKBENCH"
        return scene.render.engine
    for ident in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):  # assumption 2
        try:
            scene.render.engine = ident
            return ident
        except TypeError:
            continue
    print("warning: no Eevee engine id accepted; falling back to Workbench")
    scene.render.engine = "BLENDER_WORKBENCH"
    return scene.render.engine


def setup_render(cell: int, engine: str) -> None:
    scene = bpy.context.scene
    used = set_engine(engine)
    if used.startswith("BLENDER_EEVEE") and hasattr(scene, "eevee"):
        scene.eevee.taa_render_samples = 16
    scene.render.resolution_x = cell
    scene.render.resolution_y = cell
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True  # composite onto a uniform gray in the stitcher
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"  # flat neutral, no filmic curve


def setup_lighting() -> None:
    """Flat neutral: one sun + uniform world ambient."""
    sun_data = bpy.data.lights.new("spike_sun", type="SUN")
    sun_data.energy = 3.0
    sun_data.angle = math.radians(15)  # soft-ish shadows
    sun = bpy.data.objects.new("spike_sun", sun_data)
    bpy.context.scene.collection.objects.link(sun)
    # from over the camera's left shoulder, pointing down at the origin
    sun.rotation_euler = (math.radians(50), 0.0, math.radians(AZIMUTH_DEG + 30))

    world = bpy.data.worlds.new("spike_world")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs[0].default_value = (0.5, 0.5, 0.5, 1.0)  # ambient color
        bg.inputs[1].default_value = 0.6                   # ambient strength


def setup_camera() -> bpy.types.Object:
    cam_data = bpy.data.cameras.new("spike_cam")
    cam_data.lens = 50.0
    cam_data.sensor_fit = "VERTICAL"  # square renders: make the sensor_height FOV math exact
    cam_data.clip_start = 0.01
    cam_data.clip_end = 1000.0
    cam = bpy.data.objects.new("spike_cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def aim_camera(cam: bpy.types.Object, target: Vector, radius: float,
               elev_deg: float, margin: float) -> None:
    """Place the camera on the 3/4-front spherical offset so a sphere of `radius`
    around `target` fills the frame (square render: use the lens' vertical FOV)."""
    cam_data = cam.data
    fov = 2.0 * math.atan(cam_data.sensor_height / (2.0 * cam_data.lens))
    dist = max(radius, 1e-4) * margin / math.tan(fov / 2.0)
    az = math.radians(AZIMUTH_DEG)
    el = math.radians(elev_deg)
    offset = Vector((math.sin(az) * math.cos(el),
                     -math.cos(az) * math.cos(el),   # -Y side = front (assumption 5)
                     math.sin(el))) * dist
    cam.location = target + offset
    direction = target - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


# ---------------------------------------------------------------------------- measuring

def world_bounds(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for obj in meshes:
        for corner in obj.bound_box:  # bind-pose bounds; armature modifier not applied here
            w = obj.matrix_world @ Vector(corner)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    if not all(math.isfinite(v) for v in (*lo, *hi)):
        die("could not compute mesh bounds")
    return lo, hi


def bones_by_hints(armature: bpy.types.Object, hints: tuple[str, ...]) -> list[bpy.types.PoseBone]:
    found = [pb for pb in armature.pose.bones if any(h in pb.name.lower() for h in hints)]
    # prefer the earliest hint category present (e.g. clavicles over generic 'arm' matches)
    for hint in hints:
        subset = [pb for pb in found if hint in pb.name.lower()]
        if subset:
            return subset
    return found


def posed_point(armature: bpy.types.Object, bones: list[bpy.types.PoseBone]) -> Vector:
    acc = Vector((0.0, 0.0, 0.0))
    for pb in bones:
        acc += armature.matrix_world @ pb.head  # assumption 6
    return acc / len(bones)


# ---------------------------------------------------------------------------- stitching

def stitch(cells: list[list[str]], row_titles: list[str], col_labels: list[str],
           out_path: str, cell_px: int, header: str) -> None:
    try:
        from PIL import Image, ImageDraw
    except ImportError as exc:
        die(f"Pillow is required to stitch the sheet ({exc}). pip install pillow "
            f"- individual cell PNGs were kept for manual assembly.")
    cols = max(len(r) for r in cells)
    rows = len(cells)
    top = LABEL_STRIP_PX * 2  # header + column labels
    bg = int(BACKGROUND_GRAY * 255)
    sheet = Image.new("RGB", (cols * cell_px, top + rows * cell_px), (bg, bg, bg))
    draw = ImageDraw.Draw(sheet)
    draw.text((4, 2), header, fill=(230, 230, 230))
    for c, label in enumerate(col_labels):
        draw.text((c * cell_px + 4, LABEL_STRIP_PX + 2), label, fill=(200, 200, 200))
    for r, row in enumerate(cells):
        for c, path in enumerate(row):
            with Image.open(path) as im:
                im = im.convert("RGBA")
                tile = Image.new("RGBA", im.size, (bg, bg, bg, 255))
                tile.alpha_composite(im)
                sheet.paste(tile.convert("RGB"), (c * cell_px, top + r * cell_px))
        draw.text((4, top + r * cell_px + 2), row_titles[r], fill=(255, 210, 120))
    sheet.save(out_path)


# ---------------------------------------------------------------------------- main

def main() -> None:
    args = parse_args()
    out_path = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    reset_scene()
    import_glb(os.path.abspath(args.input))
    armature, meshes = find_character()
    print(f"character: armature '{armature.name}', {len(meshes)} skinned mesh(es), "
          f"{len(armature.pose.bones)} bones")

    action = pick_action(args.clip)
    scene = bpy.context.scene
    if action is not None:
        isolate_action(armature, action)
        f0, f1 = action.frame_range  # assumption 3
        n = args.frames if f1 > f0 else 1
        samples = [f0 + (f1 - f0) * i / max(n - 1, 1) for i in range(n)]
        fps = scene.render.fps / scene.render.fps_base
        print(f"clip '{action.name}': frames {f0:.1f}..{f1:.1f} @ {fps:g} fps "
              f"-> sampling {n} frames")
    else:
        print("no animation clips in file - rendering bind pose only")
        samples = [float(scene.frame_current)]

    # framing measurements (bind-pose bounds; camera for row 1 stays fixed - assumption in docstring)
    lo, hi = world_bounds(meshes)
    center = (lo + hi) / 2.0
    height = max(hi.z - lo.z, 1e-4)
    full_radius = max((hi - lo).length / 2.0, 1e-4)

    shoulder_bones = bones_by_hints(armature, SHOULDER_NAME_HINTS)
    pelvis_bones = bones_by_hints(armature, PELVIS_NAME_HINTS)
    if not shoulder_bones or not pelvis_bones:
        missing = [n for n, b in (("shoulders", shoulder_bones), ("pelvis", pelvis_bones)) if not b]
        print(f"warning: no bones matched name hints for {missing}; "
              f"falling back to bbox height fractions (assumption 7)")
    else:
        print(f"close-up anchors: shoulders={[b.name for b in shoulder_bones]}, "
              f"pelvis={[b.name for b in pelvis_bones]}")

    setup_render(args.cell_size, args.engine)
    setup_lighting()
    cam = setup_camera()

    def shoulder_target() -> Vector:
        if shoulder_bones:
            return posed_point(armature, shoulder_bones)
        return Vector((center.x, center.y, lo.z + height * SHOULDER_HEIGHT_FRAC))

    def pelvis_target() -> Vector:
        if pelvis_bones:
            return posed_point(armature, pelvis_bones)
        return Vector((center.x, center.y, lo.z + height * PELVIS_HEIGHT_FRAC))

    rows = [
        ("full 3/4", lambda: center, full_radius, ELEV_FULL_DEG, MARGIN_FULL),
        ("shoulders", shoulder_target, height * SHOULDER_RADIUS_FRAC, ELEV_CLOSE_DEG, 1.0),
        ("pelvis", pelvis_target, height * PELVIS_RADIUS_FRAC, ELEV_CLOSE_DEG, 1.0),
    ]

    tmp_dir = tempfile.mkdtemp(prefix="contact-sheet-")
    cell_paths: list[list[str]] = [[] for _ in rows]
    for ci, frame in enumerate(samples):
        scene.frame_set(int(frame), subframe=frame - int(frame))
        bpy.context.view_layer.update()
        for ri, (name, target_fn, radius, elev, margin) in enumerate(rows):
            aim_camera(cam, target_fn(), radius, elev, margin)
            cell = os.path.join(tmp_dir, f"r{ri}c{ci}.png")
            scene.render.filepath = cell
            try:
                bpy.ops.render.render(write_still=True)
            except Exception as exc:
                die(f"render failed at frame {frame:.1f} row '{name}': {exc} "
                    f"(if using --engine eevee headless, retry with --engine workbench)")
            cell_paths[ri].append(cell)
            print(f"  rendered {name} frame {frame:.1f} -> {cell}")

    fps = scene.render.fps / scene.render.fps_base
    col_labels = [f"f{f:.1f} ({f / fps:.2f}s)" for f in samples]
    clip_name = action.name if action is not None else "bind pose"
    header = (f"{os.path.basename(args.input)} | clip: {clip_name} | "
              f"{len(samples)} frame(s) | engine: {scene.render.engine}")
    stitch(cell_paths, [r[0] for r in rows], col_labels, out_path, args.cell_size, header)
    print(f"contact sheet written: {out_path} "
          f"({len(samples)} cols x {len(rows)} rows, cells in {tmp_dir})")


if __name__ == "__main__":
    main()
