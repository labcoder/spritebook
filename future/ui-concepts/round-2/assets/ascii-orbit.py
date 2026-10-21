"""Original ASCII torus study. Run here to regenerate the three SVG colorways."""

from html import escape
from math import cos, sin, tau
from pathlib import Path

WIDTH, HEIGHT, FRAMES = 48, 16, 12
RAMP = ".,:;irsXA253hMHGS#9B&@"


def frame(phase):
    cells, depth = [" "] * (WIDTH * HEIGHT), [-99.0] * (WIDTH * HEIGHT)
    a, b = 0.8 + phase * 0.5, phase * 0.65
    for j in range(96):
        v = j * tau / 96
        for k in range(48):
            u = k * tau / 48
            x, y, z = (1.5 + 0.62 * cos(u)) * cos(v), (1.5 + 0.62 * cos(u)) * sin(v), 0.62 * sin(u)
            y, z = y * cos(a) - z * sin(a), y * sin(a) + z * cos(a)
            x, y = x * cos(b) - y * sin(b), x * sin(b) + y * cos(b)
            column, row = round(23.5 + x * 9), round(7.5 + y * 3.3)
            if not (0 <= column < WIDTH and 0 <= row < HEIGHT):
                continue
            index = row * WIDTH + column
            if z <= depth[index]:
                continue
            depth[index] = z
            light = max(0.0, min(1.0, (z + 1.6) / 3.5))
            cells[index] = RAMP[round(light * (len(RAMP) - 1))]
    rows = ["".join(cells[y * WIDTH:(y + 1) * WIDTH]) for y in range(HEIGHT)]
    assert len(rows) == HEIGHT and all(len(row) == WIDTH for row in rows)
    assert sum(c != " " for row in rows for c in row) > 100, "Empty projection"
    return rows


frames = [frame(n * tau / FRAMES) for n in range(FRAMES)]
assert len({"".join(rows) for rows in frames}) == FRAMES, "Orbit must change"
for name, ink in [("blue", "#2634da"), ("green", "#cee3b2"), ("copper", "#85452f")]:
    groups = []
    for i, rows in enumerate(frames):
        lines = "".join(f'<tspan x="0" y="{8 + y * 8}">{escape(row)}</tspan>' for y, row in enumerate(rows))
        groups.append(f'<g class="frame f{i}" style="animation-delay:{i * .375:.3f}s"><text xml:space="preserve">{lines}</text></g>')
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="240" height="128" viewBox="0 0 240 128" role="img" aria-label="An original rotating ASCII torus">
<metadata>SpriteBook identity study. Original procedural vector art; ascii-orbit.py. No model output or third-party illustration. Motion ends at 4.5 seconds and respects reduced motion.</metadata>
<style>text{{font:8px monospace;fill:{ink}}}.frame{{opacity:0;animation:expose .375s step-end 1}}.f0{{opacity:1;animation:hold 4.5s step-end 1}}@keyframes expose{{from{{opacity:1}}to{{opacity:0}}}}@keyframes hold{{0%{{opacity:1}}8.33%,99.99%{{opacity:0}}100%{{opacity:1}}}}@media(prefers-reduced-motion:reduce){{.frame{{animation:none}}.f0{{opacity:1}}}}</style>
{"".join(groups)}
</svg>
'''
    Path(__file__).with_name(f"ascii-orbit-{name}.svg").write_text(svg, encoding="utf-8")
    still = f'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="128" viewBox="0 0 240 128"><metadata>Original SpriteBook ASCII torus; static reduced-motion version. Source: ascii-orbit.py.</metadata><text xml:space="preserve" style="font:8px monospace;fill:{ink}">'
    still += "".join(f'<tspan x="0" y="{8 + y * 8}">{escape(row)}</tspan>' for y, row in enumerate(frames[0]))
    Path(__file__).with_name(f"ascii-orbit-{name}-still.svg").write_text(still + '</text></svg>\n', encoding="utf-8")
print("Wrote three orbit colorways and stills; 12 distinct projections, finite motion.")
