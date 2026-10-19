import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The full-journey keyboard walkthrough as a REGRESSION GATE (P4-T1's last
 * acceptance item, kept honest): any finding - an unreachable control, focus
 * dropped to <body> after an async action, a radiogroup that ignores arrow
 * keys - fails this test.
 *
 * Gated like the other hardware lanes: it needs the DESKTOP APP running with
 * the WebView2 debug port, which CI does not have. Without the env var the
 * test says so and asserts nothing, in the suite's honest-skip voice.
 *
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run dev:desktop
 *   npm run test:walkthrough
 */
import { assertEquals } from '@std/assert';
import { Cdp } from './walkthrough.ts';
import { runJourney } from './journey.ts';

test('full-journey keyboard-only walkthrough: zero findings', async (t) => {
  const port = process.env['SPRITEBOOK_CDP_PORT'];
  if (!port) {
    t.skip('SPRITEBOOK_CDP_PORT is not set');
    return;
  }

  // a fresh root per run - the journey creates a character and must not
  // collide with an earlier one
  const root = await fs.mkdtemp(join(tmpdir(), 'sb-walkthrough-'));
  const image = new URL('../../tests/fixtures/bulma-front.png', import.meta.url)
    .pathname
    .replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\');

  const cdp = await Cdp.connect(Number(port));
  try {
    const { findings, trace } = await runJourney(cdp, {
      root,
      image,
      name: `kb-${Date.now().toString(36)}`,
      log: (s) => console.log(s),
    });
    assertEquals(
      findings,
      [],
      `the keyboard journey broke:\n${findings.join('\n')}\n\nfull trace:\n${trace.join('\n')}`,
    );
  } finally {
    cdp.close();
    await fs.rm(root, { recursive: true }).catch(() => {});
  }
});
