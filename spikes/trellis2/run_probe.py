"""
Does TRELLIS.2 actually run on this machine, and in how much VRAM?

Drives the weights ALREADY installed through SpriteBook's own registry, at a
given pipeline type, and reports peak VRAM + wall time per stage. Nothing here
is production code — it exists to answer one question before any is written.

  python run_probe.py --type 512
  python run_probe.py --type 1024_cascade
"""
import argparse
import json
import os
import time

os.environ['OPENCV_IO_ENABLE_OPENEXR'] = '1'
# expandable_segments cuts peak reserved by letting the allocator grow a segment
# instead of holding a second one; the official example sets it too.
os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'
os.environ.setdefault('ATTN_BACKEND', 'xformers')  # flash-attn needs a compiler

import torch  # noqa: E402
from PIL import Image  # noqa: E402

WEIGHTS = r'C:\Users\oms10\AppData\Local\spritebook\models\trellis2-4b\af44b45f'


def gib(n: int) -> float:
    return round(n / 1024 ** 3, 2)


class Peak:
    """Peak allocated/reserved since the last reset, in GiB."""

    def __init__(self, label: str):
        self.label = label

    def __enter__(self):
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc):
        torch.cuda.synchronize()
        self.secs = round(time.perf_counter() - self.t0, 2)
        self.alloc = gib(torch.cuda.max_memory_allocated())
        self.reserved = gib(torch.cuda.max_memory_reserved())
        print(
            f'  {self.label:<22} {self.secs:>7.2f}s   '
            f'peak alloc {self.alloc:>6.2f} GiB   reserved {self.reserved:>6.2f} GiB',
            flush=True,
        )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--type', default='512', help="512 | 1024 | 1024_cascade | 1536_cascade")
    ap.add_argument('--image', default='code/assets/example_image/T.png')
    ap.add_argument('--out', default='out')
    args = ap.parse_args()

    props = torch.cuda.get_device_properties(0)
    free, total = torch.cuda.mem_get_info()
    print(f'GPU: {props.name}  total {gib(total)} GiB  free at start {gib(free)} GiB')
    print(f'pipeline_type: {args.type}\n')

    from trellis2.pipelines import Trellis2ImageTo3DPipeline

    with Peak('load pipeline') as p_load:
        pipeline = Trellis2ImageTo3DPipeline.from_pretrained(WEIGHTS)
        pipeline.cuda()

    image = Image.open(args.image)
    with Peak('run (image -> mesh)') as p_run:
        mesh = pipeline.run(image, seed=42, pipeline_type=args.type)[0]

    with Peak('export glb') as p_glb:
        import o_voxel
        os.makedirs(args.out, exist_ok=True)
        mesh.simplify(16777216)
        glb = o_voxel.postprocess.to_glb(
            vertices=mesh.vertices,
            faces=mesh.faces,
            attr_volume=mesh.attrs,
            coords=mesh.coords,
            attr_layout=mesh.layout,
            voxel_size=mesh.voxel_size,
            aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
            decimation_target=200000,
            texture_size=2048,
            remesh=True,
            remesh_band=1,
            remesh_project=0,
            verbose=False,
        )
        out_glb = os.path.join(args.out, f'sample_{args.type}.glb')
        glb.export(out_glb)

    overall = max(p_load.reserved, p_run.reserved, p_glb.reserved)
    result = {
        'pipelineType': args.type,
        'gpu': props.name,
        'totalVramGiB': gib(total),
        'freeAtStartGiB': gib(free),
        'peakReservedGiB': overall,
        'peakAllocatedGiB': max(p_load.alloc, p_run.alloc, p_glb.alloc),
        'secondsLoad': p_load.secs,
        'secondsRun': p_run.secs,
        'secondsGlb': p_glb.secs,
        'secondsTotal': round(p_load.secs + p_run.secs + p_glb.secs, 2),
        'glb': out_glb,
        'glbBytes': os.path.getsize(out_glb),
    }
    print(f'\n  PEAK RESERVED {overall} GiB of {gib(free)} GiB free at start')
    print(f'  TOTAL {result["secondsTotal"]}s -> {out_glb} ({result["glbBytes"]:,} bytes)')
    with open(os.path.join(args.out, f'probe_{args.type}.json'), 'w', newline='\n') as f:
        json.dump(result, f, indent=2)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
