# Maintained portable Blender: Windows trial

2026-10-23, F5-T2/F6-T1 and F3-T2. **Blender 4.5.15 LTS works as an optional standalone worker, but
upgrading the engine alone does not repair the current garments.** Keep automatic cloth correction
experimental. No live character, source asset, default runtime or release was replaced by this
trial.

## Verified distribution

Blender lists 4.5 as a maintained LTS series, supported until July 2027; 4.5.15 was released on
2026-10-22. This is a maintained baseline, not a claim that it is the newest LTS series. Sources:
[LTS status](https://www.blender.org/download/lts/) and
[4.5 release history](https://www.blender.org/releases/4-5/).

Exactly one official Windows x64 portable archive was downloaded. The ordinary download host
returned an HTTP challenge; the official `mirror.blender.org` host served the archive and checksum.
Its SHA-256 was verified **before extraction or execution** against the
[published checksum file](https://mirror.blender.org/release/Blender4.5/blender-4.5.15.sha256).

| Item                    | Verified value                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Archive                 | [blender-4.5.15-windows-x64.zip](https://mirror.blender.org/release/Blender4.5/blender-4.5.15-windows-x64.zip) |
| Compressed bytes        | 398,649,826                                                                                                    |
| Archive SHA-256         | `52dd02fd74877fa08e74b67d7854cf32468a232c02aaa19b6844c91285574f8d`                                             |
| Extracted logical bytes | 924,669,131                                                                                                    |
| `blender.exe` SHA-256   | `935e4bed28e51d08b8e1fbcc31dcccc000cc1c3dd065d82dcb1da813e75db795`                                             |
| Reported build          | 4.5.15 LTS, `5afeabba6097`, Windows AMD64, 64-bit                                                              |

Archive sizes are corroborated by the
[official release index](https://download.blender.org/release/Blender4.5/). Archive plus extracted
files plus a 10% allocation margin is 1,455,650,853 bytes. This is an initial installation estimate;
it excludes an existing version retained during replacement, correction outputs, logs,
filesystem-specific allocation and unrelated concurrent writes. Background operation still needs the
full portable distribution. Windows ZIP deployment requires no administrator installation or file
association changes, as described in the
[installation manual](https://docs.blender.org/UATEST/manual/en/4.5/getting_started/installing/windows.html).

The existing license tree and `copyright.txt` remain intact. Blender binaries use GPL-compatible
components under GPL-3.0-or-later distribution terms; using a separate process does not remove
distribution obligations. Retain notices and the matching
[source archive](https://mirror.blender.org/source/blender-4.5.15.tar.xz), verified available by
HTTP HEAD at 85,115,596 bytes. The source archive was not downloaded in this trial. See
[Blender's license explanation](https://www.blender.org/about/license/). The base SpriteBook bundle
does not acquire this engine; it remains a separately chosen optional tool.

## Native execution and ownership

The actual standalone executable ran with `--background --factory-startup --disable-autoexec
--python-exit-code 2 --python <worker>`. These are native CLI tests, unlike the earlier embedded
`bpy` baseline. Blender documents background/script operation in its
[command-line manual](https://docs.blender.org/manual/it/4.5/advanced/command_line/arguments.html).

Each job used separate config, scripts, data and temporary directories. A Windows kill-on-close Job
Object owned the worker tree before Blender started, with file-backed logs and a 180-second limit.
Explicit standalone cancellation completed in 2.031 seconds and timeout in 3.000 seconds; their
outcomes remained distinct. This provides process/config isolation, not a security sandbox for
arbitrary community scripts. Production should isolate the user extensions directory too.

Native import, two-joint armature, normalized weights, a four-frame cloth operator and GLB export
all passed with exit 0. Independent glTF-Transform validation confirmed finite geometry and inverse
binds, valid indices and normalized weights. Blender still splits eight unique hard-normal positions
into 24 render vertices; a whole-GLB round trip is not source-index preserving. Corrections should
use validated neutral arrays tied to original indices. The smoke took 10.297 seconds and 221 MB peak
process-tree **Job committed memory**, not RSS or a minimum hardware requirement.

## Walk and jump quality

The same previously prepared inputs, solver settings and Surface Deform bindings were copied into an
isolated trial directory. No re-binding or input repair was mixed into this comparison. This tests
whether changing to a maintained standalone engine improves the existing method. It does not test
every Blender cloth configuration or establish that Blender cannot produce a good result.

Both the authored one-layer control and the detailed Bulma garment ran walk, jump start, airborne
loop and landing: 20 settle frames, 30 approach frames and 17 evaluated samples per clip. All eight
native processes completed successfully. **Every resulting neutral NPZ is byte-for-byte identical to
the retained bpy 4.2 baseline**, including proxy, original-detail positions and sample indices.
Loading the prepared file does not reuse a cloth simulation cache: the worker adds and evaluates a
new Cloth modifier.

| Authored control | Final capsule contacts | Worst final P99 edge/rest | Result                                               |
| ---------------- | ---------------------: | ------------------------: | ---------------------------------------------------- |
| Walk             |                      0 |                    1.122× | Sampled shape/contact pass; loop fails               |
| Jump start       |                     39 |                    1.720× | Contact and shape fail                               |
| Airborne loop    |                      0 |                    1.052× | Sampled shape/contact pass; loop remains unqualified |
| Landing          |                  2,863 |                    1.838× | Contact and shape fail                               |

The maintained-engine walk still has 73.77 mm P99 endpoint mismatch after removing pelvis motion.
Three cycles of preroll reduce this to 25.48 mm but introduce five final triangle/capsule contacts;
the result still fails. No endpoint blend or acceptance threshold change conceals this.

All 81,003 selected detail vertices and 163,557 original garment triangles remain present for the
actual-character checks. The independent final-triangle checks include the retained partial body,
attachment boundaries, seams and nonadjacent self-crossings, rather than judging only the carrier.

| Detailed garment | Capsule contacts | Worst P99 edge/rest | Worst boundary P99/rest | Actual-body crossings |
| ---------------- | ---------------: | ------------------: | ----------------------: | --------------------: |
| Walk             |          116,526 |              4.214× |                  17.39× |                31,612 |
| Jump start       |           59,432 |              6.798× |                  37.09× |                12,590 |
| Airborne loop    |          223,996 |              5.512× |                  20.66× |                68,631 |
| Landing          |          192,200 |              6.958× |                  50.10× |                83,777 |

These contact numbers sum observations over 17 samples, not unique bad triangles. Actual-body
coverage remains partial; strict noncoplanar crossings exclude touching/coplanar contacts and do not
certify continuous collision freedom. Observed failures suffice to reject these candidates. Landing
detailed self-crossings remain 8,656,139 observations versus 218,953 for original LBS.

Twelve fresh frozen full-model snapshots were rendered through SpriteBook core with fixed cameras
and original textures; both front and side directions were emitted. The reviewed side comparisons
show cloth crumpling and severe landing waist tears/coverage loss. Private images are
`.render-bench/maintained-blender-2026-10-23/proof/{walk-loop,jump-land}-comparison.png`.

Control simulation takes 4.06–4.39 seconds at 224–250 MB peak Job committed memory; detailed
simulation takes 6.81–8.16 seconds at 610–652 MB. Final capsule/body/self-contact validation costs
are separate. These CPU cloth jobs overlapped other approved research on a Windows x64,
10-core/20-thread machine with about 64 GiB installed RAM. They are workload observations, not
isolated benchmarks, a GPU requirement or weak-machine qualification. The earlier report measured
RSS, so its memory figures are not directly comparable. Core evidence rendering used the available
Vulkan GPU; Blender cloth itself did not request CUDA.

## Decision and replay

Support **use an existing installation** and **download a managed portable copy** under the same
extensions lifecycle. A native operator probe can report tool readiness separately from method
quality. Neither installing Blender nor a green capability probe should imply automatic garment
repair is ready. Continue ownership, body coverage and attachment preparation before adopting a
production correction cache. See [guided repair findings](guided-motion-repair.md) and
[prepared garment findings](cloth-evaluation.md).

Private evidence, exact input/output hashes, pin metadata, owned logs and executable remain under
`.render-bench/maintained-blender-2026-10-23/`. Replay from the repository root using the existing
sidecar Python, with no new Python environment or packages:

```powershell
$trial = '.render-bench/maintained-blender-2026-10-23'
sidecar/.venv/Scripts/python.exe "$trial/run-smoke.py"
node "$trial/validate-output.mjs"
sidecar/.venv/Scripts/python.exe "$trial/ownership-check.py"
sidecar/.venv/Scripts/python.exe "$trial/run-all.py"
sidecar/.venv/Scripts/python.exe "$trial/run-mesh-checks.py"
sidecar/.venv/Scripts/python.exe "$trial/summarize.py"
sidecar/.venv/Scripts/python.exe "$trial/proof-input.py"
$env:SPRITEBOOK_GPU_BACKEND = 'vulkan'
.build/runtime/node.exe "$trial/proof.mjs"
sidecar/.venv/Scripts/python.exe "$trial/compose.py"
```

All owned workers stopped. The optional portable copy is retained for manager/offline lifecycle
testing. Native Mac/Linux/ARM, weaker devices, other solver configurations, interactive manual
handoff/reimport and production animated correction parity remain unqualified.
