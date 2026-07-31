/**
 * The ratified token layer, held to its own commitments (design-system.md):
 *
 *  1. every colour is a semantic light/dark pair — both themes define the
 *     same token set, nothing falls through to the other theme by accident;
 *  2. WCAG 2.1 AA — text on its surfaces, in both themes, computed here so a
 *     future "tweak one hex" cannot silently break contrast;
 *  4. canvas wells stay dark in BOTH themes — the checker tokens are
 *     theme-invariant by value;
 *  plus the two ratified deltas: state/ok diverges in hue by theme, and
 *  light's line/strong is stronger than its line.
 *
 * Runs under the plain Deno suite: it parses tokens.css textually — the file
 * IS the contract, no browser needed.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';

const css = await Deno.readTextFile(new URL('./src/tokens.css', import.meta.url));

function block(selector: string): string {
  // the first rule whose selector list contains `selector` verbatim
  const at = css.indexOf(selector);
  assert(at >= 0, `selector ${selector} present`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function tokensOf(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/--([a-z-]+):\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

const dark = tokensOf(block(":root[data-theme='dark']"));
const light = tokensOf(block(":root[data-theme='light']"));

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  assert(h.length === 6, `token value is a 6-digit hex, got "${hex}"`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2.1 relative luminance + contrast ratio. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = hexToRgb(hex).map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

Deno.test('both themes define the identical token set — no accidental fallthrough', () => {
  assertEquals([...dark.keys()].sort(), [...light.keys()].sort());
  assert(dark.size >= 16, `the layer is the full ratified table (${dark.size} tokens)`);
});

Deno.test('AA: primary and secondary text hold 4.5:1 on every surface, both themes', () => {
  for (const [name, t] of [['dark', dark], ['light', light]] as const) {
    for (const surface of ['sb-bg', 'sb-panel', 'sb-raise']) {
      for (const text of ['sb-text', 'sb-dim']) {
        const ratio = contrast(t.get(text)!, t.get(surface)!);
        assert(
          ratio >= 4.5,
          `${name}: ${text} on ${surface} is ${ratio.toFixed(2)}:1, AA wants 4.5:1`,
        );
      }
    }
  }
});

Deno.test('AA: the primary action reads — on-acid ink on the acid fill', () => {
  for (const t of [dark, light]) {
    const ratio = contrast(t.get('sb-on-acid')!, t.get('sb-acid')!);
    assert(ratio >= 4.5, `on-acid on acid is ${ratio.toFixed(2)}:1`);
  }
});

Deno.test('rule 4: the canvas well checker is dark in BOTH themes, by value', () => {
  for (const k of ['sb-check-a', 'sb-check-b']) {
    assertEquals(dark.get(k), light.get(k), `${k} must not follow the theme`);
    const [r, g, b] = hexToRgb(dark.get(k)!);
    assert((r + g + b) / 3 < 64, `${k} stays dark (mean channel ${(r + g + b) / 3})`);
  }
});

Deno.test('the ratified deltas: ok diverges by theme; light line/strong is stronger', () => {
  assertEquals(dark.get('sb-ok'), dark.get('sb-acid'), 'dark ok IS acid');
  assertEquals(light.get('sb-ok'), light.get('sb-cobalt'), 'light ok IS cobalt ink');
  assert(dark.get('sb-ok') !== light.get('sb-ok'), 'the hue divergence is real');
  // stronger = darker than line on the light ground
  const mean = (hex: string) => hexToRgb(hex).reduce((a, c) => a + c, 0) / 3;
  assert(
    mean(light.get('sb-line-strong')!) < mean(light.get('sb-line')!),
    'light line/strong is darker than line',
  );
});

Deno.test('every accent-as-text ink clears 4.5:1 on panel AND raise, both themes', () => {
  // rule 5 generalized by the manual AA pass: accents in a TEXT role go
  // through -ink tokens (tags, drawer severities, badges). Cobalt has no ink
  // on purpose — it fails as text on dark and is a focus ring, never copy.
  const inks = ['sb-acid-ink', 'sb-magenta-ink', 'sb-cyan-ink', 'sb-sun-ink', 'sb-signal-ink'];
  for (const [name, t] of [['dark', dark], ['light', light]] as const) {
    for (const ink of inks) {
      assert(t.has(ink), `${name} defines ${ink}`);
      for (const surface of ['sb-panel', 'sb-raise']) {
        const ratio = contrast(t.get(ink)!, t.get(surface)!);
        assert(
          ratio >= 4.5,
          `${name}: ${ink} on ${surface} is ${ratio.toFixed(2)}:1, AA wants 4.5:1`,
        );
      }
    }
  }
});

Deno.test('status hues stay AA-legible as TEXT on the status bar panel', () => {
  // the status bar renders ok/signal as text on panel — that is a real usage
  // in App.tsx, so it is a real constraint here
  for (const [name, t] of [['dark', dark], ['light', light]] as const) {
    for (const k of ['sb-ok', 'sb-signal']) {
      const ratio = contrast(t.get(k)!, t.get('sb-panel')!);
      assert(ratio >= 4.5, `${name}: ${k} text on panel is ${ratio.toFixed(2)}:1`);
    }
  }
});
