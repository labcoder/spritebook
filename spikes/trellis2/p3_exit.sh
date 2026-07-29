#!/usr/bin/env bash
# P3 exit measurement: image -> engine, on a REAL generated character.
#
# The phase exit is "<=30 min image->engine-imported character, measured end to
# end". Every prior claim on that number used `fixture-gen`, because until this
# session `gen --model trellis2-4b` never reached its adapter at all - the
# catalog id and the adapter id have never matched. So this is the first run of
# the chain on a mesh a real backend produced, and the first time `rig` has seen
# a 200k-face generated character rather than a fixture or the canonical body.
#
# gen is already done (bulma r5). This times what follows it, and does NOT work
# around failures - a broken stage is the finding.
set -u
cd "$(dirname "$0")/../.."
# Defaults to the workspace generated WITH --height under the vertex-baking
# border (the verb-e2e/bulma workspace predates both and re-measures the old
# defect, which is only useful as history). Override: p3_exit.sh <ws> <result>.
WS=${1:-spikes/trellis2/out/p3-exit/bulma-fixed}
RESULT=${2:-r1}
PERMS="--allow-read --allow-write --allow-env --allow-ffi --allow-net=127.0.0.1 --allow-run"
LOG=spikes/trellis2/out/p3-exit
mkdir -p "$LOG"

stage() {
  local name="$1"; shift
  local t0=$SECONDS
  echo "=== $name ==="
  "$@" > "$LOG/$name.log" 2>&1
  local rc=$?
  local dt=$((SECONDS - t0))
  grep -E "^(warn|error)" "$LOG/$name.log" | head -6 || true
  echo "--- $name: ${dt}s (exit $rc)"
  echo "$name,$dt,$rc" >> "$LOG/timings.csv"
  return 0   # keep going; a broken stage is data, not a reason to stop
}

rm -f "$LOG/timings.csv"

stage pick deno run $PERMS packages/cli/mod.ts pick --workspace "$WS" --result "$RESULT"

stage rig deno run $PERMS packages/cli/mod.ts rig \
  --model "$WS/canonical/model.glb" --out "$WS/rig" --workspace "$WS"

stage bake deno run $PERMS packages/cli/mod.ts bake --workspace "$WS"

# newest by mtime, matching the manifest lastBakeId - alphabetical head -1
# exported a stale bake once the workspace held more than one
BAKE=$(ls -dt "$WS"/bakes/bake-* 2>/dev/null | head -1)
if [ -n "$BAKE" ]; then
  stage export deno run $PERMS packages/cli/mod.ts export \
    --bake "$BAKE" --out "$WS/export" --targets godot
else
  echo "=== export ==="
  echo "--- export: SKIPPED, no bake directory under $WS/bakes"
  echo "export,0,skipped" >> "$LOG/timings.csv"
fi

echo
echo "TIMINGS"
cat "$LOG/timings.csv"
echo "P3 EXIT DONE"
