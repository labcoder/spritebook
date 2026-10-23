import { promises as fs } from 'node:fs';
import { test } from 'node:test';
/** Contrast and pixel-surround contracts for both Imprint themes. */
import { assert, assertEquals } from '@std/assert';

const css = await fs.readFile(new URL('./src/tokens.css', import.meta.url), 'utf8');

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
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('both themes define the identical token set — no accidental fallthrough', () => {
  assertEquals([...dark.keys()].sort(), [...light.keys()].sort());
  assert(dark.size >= 16, `the layer is the full ratified table (${dark.size} tokens)`);
});

test('AA: primary and secondary text hold 4.5:1 on every surface, both themes', () => {
  for (const [name, t] of [['dark', dark], ['light', light]] as const) {
    for (const surface of ['sb-bg', 'sb-panel', 'sb-chrome', 'sb-raise', 'sb-footer']) {
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

test('AA: primary actions, current stages, and error badges keep readable text', () => {
  for (const [name, t] of [['dark', dark], ['light', light]] as const) {
    for (
      const [text, fill] of [
        ['sb-on-action', 'sb-action'],
        ['sb-on-action', 'sb-action-hover'],
        ['sb-on-current', 'sb-current'],
        ['sb-on-danger', 'sb-danger'],
      ]
    ) {
      const ratio = contrast(t.get(text)!, t.get(fill)!);
      assert(ratio >= 4.5, `${name}: ${text} on ${fill} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('rule 4: the canvas well checker is dark in BOTH themes, by value', () => {
  for (const k of ['sb-check-a', 'sb-check-b']) {
    assertEquals(dark.get(k), light.get(k), `${k} must not follow the theme`);
    const [r, g, b] = hexToRgb(dark.get(k)!);
    assert((r + g + b) / 3 < 64, `${k} stays dark (mean channel ${(r + g + b) / 3})`);
  }
});

test('status text holds AA on surfaces and selected cards, both themes', () => {
  for (const [name, t] of [['dark', dark], ['light', light]] as const) {
    for (const ink of ['sb-accent', 'sb-ok', 'sb-warning', 'sb-danger', 'sb-dim']) {
      for (const surface of ['sb-bg', 'sb-panel', 'sb-raise', 'sb-select-bg', 'sb-footer']) {
        const ratio = contrast(t.get(ink)!, t.get(surface)!);
        assert(ratio >= 4.5, `${name}: ${ink} on ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('fields and focus rings have visible boundaries, both themes', () => {
  for (const [name, t] of [['dark', dark], ['light', light]] as const) {
    for (const ink of ['sb-line-strong', 'sb-focus']) {
      const ratio = contrast(t.get(ink)!, t.get('sb-panel')!);
      assert(ratio >= 3, `${name}: ${ink} on panel is ${ratio.toFixed(2)}:1`);
    }
    const ratio = contrast(t.get('sb-well-text')!, t.get('sb-check-b')!);
    assert(ratio >= 4.5, `${name}: preview captions are ${ratio.toFixed(2)}:1`);
  }
});

test('the selection surface holds its text at 4.5:1, both themes', () => {
  for (const [name, t] of [['dark', dark], ['light', light]] as const) {
    const ratio = contrast(t.get('sb-select-text')!, t.get('sb-select-bg')!);
    assert(ratio >= 4.5, `${name}: select-text on select-bg is ${ratio.toFixed(2)}:1`);
  }
});
