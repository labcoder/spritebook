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
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 deno task dev:desktop
 *   deno task test:walkthrough
 */
import { assertEquals } from 'jsr:@std/assert@1';
import { Cdp } from './walkthrough.ts';
import { runJourney } from './journey.ts';

Deno.test('full-journey keyboard-only walkthrough: zero findings', async () => {
  const port = Deno.env.get('SPRITEBOOK_CDP_PORT');
  if (!port) {
    console.log(
      'skip: SPRITEBOOK_CDP_PORT is not set, so this test asserted NOTHING. ' +
        'Start the desktop app with the debug port and run `deno task test:walkthrough`.',
    );
    return;
  }

  // a fresh root per run - the journey creates a character and must not
  // collide with an earlier one
  const root = await Deno.makeTempDir({ prefix: 'sb-walkthrough-' });
  const image = new URL('../../tests/fixtures/bulma-front.png', import.meta.url).pathname
    .replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\');

  let cdp: Cdp;
  try {
    cdp = await Cdp.connect(Number(port));
  } catch {
    console.log(
      'skip: no app is listening on the debug port, so this test asserted NOTHING. ' +
        'Start the desktop app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=' +
        port,
    );
    return;
  }
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
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
