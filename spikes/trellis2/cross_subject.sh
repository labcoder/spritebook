#!/usr/bin/env bash
# Does the metal problem follow the ART STYLE or the retexture PATH?
#
# bulma is flat anime line art and came back majority-metal on 68% of runs. If
# that is a property of flat line art, other styles should be clean. Three more
# subjects, chosen to separate the two explanations:
#
#   painted-mermaid    painted illustration   IN TRELLIS.2's example set
#   lineless-princess  soft lineless 3D       IN TRELLIS.2's example set
#   robot-astro        glossy 3D robot        NOT in it - and the one subject
#                                             here that arguably SHOULD be metal
#
# The two example-set subjects carry a confound worth naming: a clean result
# from them is consistent with "not flat line art" AND with "the model has seen
# this exact image". robot-astro is what breaks the tie, in the useful
# direction - if a literal robot reads as non-metal while a cartoon girl reads
# as chrome, the metal channel is not tracking material semantics at all.
#
# Uses the real verbs rather than a spike harness, because the ladder attempt
# count IS the thing being measured and only the verb runs the ladder.
set -u
cd "$(dirname "$0")/../.."
OUT=spikes/trellis2/out/cross-subject
PERMS="--allow-read --allow-write --allow-env --allow-ffi --allow-net=127.0.0.1 --allow-run"

for name in painted-mermaid lineless-princess robot-astro; do
  ws="$OUT/$name"
  echo "=== GEN $name ==="
  deno run $PERMS packages/cli/mod.ts gen \
    --workspace "$ws" --character "$name" \
    --image "spikes/trellis2/refs/$name.png" \
    --model trellis2-4b --seed 7 2>&1 | grep -E "^(warn|error|done)" || true

  for seed in 100 200; do
    echo "=== RETEXTURE $name seed $seed ==="
    deno run $PERMS packages/cli/mod.ts retexture \
      --workspace "$ws" --result r1 --seed "$seed" 2>&1 |
      grep -E "^(warn|error|done)" || true
  done
done
echo "ALL DONE"
