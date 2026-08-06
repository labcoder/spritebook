/**
 * The full-journey keyboard-only walkthrough, as a reusable run: new
 * character -> gen -> pick -> rig -> accept -> anim -> look -> bake ->
 * export, driven with trusted key events against the running desktop app.
 *
 * Consumed twice, deliberately:
 *   - tools/proofs/walkthrough_journey.ts runs it and writes the transcript
 *     to docs/internal/proofs/ (the acceptance evidence)
 *   - tools/proofs/walkthrough_test.ts runs it under `deno test` as the
 *     regression gate: any finding fails the test
 *
 * Two modes of truth come out of one run:
 *   - a FOCUS TRACE: every Tab hop and where it landed
 *   - a FINDINGS list: places the journey could not continue by keyboard
 *     alone, or where focus was dropped. The run does not stop at the first
 *     break - it bridges past it with a programmatic focus() and RECORDS the
 *     bridge, so one run maps every break rather than the first one.
 */
import {
  active,
  Cdp,
  evalJs,
  fmt,
  type FocusInfo,
  press,
  tabTo,
  typeText,
  waitFor,
} from './walkthrough.ts';

export interface JourneyOptions {
  /** projects root the app should load (created if missing by the caller) */
  root: string;
  /** absolute path of the source image to type into the form */
  image: string;
  /** character name to create; the workspace must not already exist */
  name: string;
  log?: (line: string) => void;
}

export interface JourneyResult {
  trace: string[];
  findings: string[];
}

export async function runJourney(cdp: Cdp, opts: JourneyOptions): Promise<JourneyResult> {
  const lines: string[] = [];
  const say = (s: string) => {
    lines.push(s);
    opts.log?.(s);
  };
  const findings: string[] = [];
  const finding = (s: string) => {
    findings.push(s);
    say(`  !! FINDING: ${s}`);
  };

  /** Where is focus after an async operation? <body> means the user was dropped. */
  const focusAfter = async (what: string) => {
    const f = await active(cdp);
    if (f.tag === 'body') finding(`focus dropped to <body> after ${what}`);
    else say(`  focus after ${what}: ${fmt(f)}`);
    return f;
  };

  /** Bridge past a break so the rest of the journey still gets audited. */
  const reach = async (
    match: (f: FocusInfo) => boolean,
    what: string,
    bridgeSelector: string,
    maxHops = 60,
  ): Promise<boolean> => {
    try {
      await tabTo(cdp, match, what, say, maxHops);
      return true;
    } catch (e) {
      finding(`${(e as Error).message} - BRIDGED with programmatic focus(${bridgeSelector})`);
      await evalJs(cdp, `document.querySelector(${JSON.stringify(bridgeSelector)})?.focus()`);
      return false;
    }
  };

  const hasText = (f: FocusInfo, t: string) => f.text.toLowerCase().includes(t.toLowerCase());
  const hasLabel = (f: FocusInfo, t: string) => f.label.toLowerCase().includes(t.toLowerCase());
  const checked = () =>
    evalJs<boolean>(cdp, `document.activeElement?.getAttribute?.('aria-checked') === 'true'`);

  say(`# Full-journey keyboard-only walkthrough`);
  say(`bridge: ${await evalJs(cdp, `(window.__TAURI__ ? 'tauri (real CLI)' : 'browser-demo')`)}`);

  // ---------------------------------------------------------------- 0 gallery
  say('\n## 0 - gallery: set the projects root');
  await evalJs(
    cdp,
    'document.activeElement && document.activeElement.blur && document.activeElement.blur()',
  );
  await reach((f) => f.id === 'root', 'projects root input', '#root');
  await press(cdp, 'End');
  await evalJs(cdp, `document.activeElement.select()`);
  await typeText(cdp, opts.root);
  await press(cdp, 'Enter');
  await waitFor(
    cdp,
    `document.querySelector('.gallery, .gallerynote, .card')`,
    'gallery load',
    15_000,
  );
  say('  root loaded');

  // ------------------------------------------------------------ 1 new character
  say('\n## 1 - new character tab');
  await reach((f) => hasLabel(f, 'New character'), 'the + (new character) button', '.tabnew');
  await press(cdp, 'Enter');
  await waitFor(cdp, `document.querySelector('#gname')`, 'the Generate form', 5_000);
  await focusAfter('opening the new-character tab');

  say('\n## 2 - generate: name, image, backend, run');
  await reach((f) => f.id === 'gname', 'name input', '#gname');
  await typeText(cdp, opts.name);
  await reach((f) => f.id === 'gimage', 'image path input', '#gimage', 10);
  await typeText(cdp, opts.image);
  // the backend cards render only after the async models list returns
  await waitFor(
    cdp,
    `document.querySelectorAll('[role=radio]').length >= 2`,
    'backend cards',
    30_000,
  );
  await reach(
    (f) => f.role === 'radio' && hasText(f, 'Fixture'),
    'the fixture-gen backend card',
    '[role=radio]',
    30,
  );
  if (!(await checked())) {
    await press(cdp, 'Space');
    if (!(await checked())) finding('backend role=radio did not select on Space');
  }
  // arrows are the contract the radio role announces: move+select, then back
  await press(cdp, 'ArrowRight');
  const arrowMoved = await evalJs<boolean>(
    cdp,
    `document.activeElement?.getAttribute?.('role') === 'radio' && document.activeElement.getAttribute('aria-checked') === 'true' && !document.activeElement.textContent.includes('Fixture')`,
  );
  if (!arrowMoved) {
    finding('backend radiogroup arrows do not move selection (the role promises they do)');
  } else {
    await press(cdp, 'ArrowLeft');
  }
  if (
    !(await checked()) ||
    !(await evalJs<boolean>(cdp, `document.activeElement.textContent.includes('Fixture')`))
  ) {
    await evalJs(
      cdp,
      `[...document.querySelectorAll('[role=radio]')].find(r => r.textContent.includes('Fixture'))?.focus()`,
    );
    if (!(await checked())) await press(cdp, 'Space');
    if (!(await checked())) {
      await evalJs(
        cdp,
        `[...document.querySelectorAll('[role=radio]')].find(r => r.textContent.includes('Fixture'))?.click()`,
      );
      finding('fixture backend could only be selected by CLICK - bridged');
    }
  }
  await reach(
    (f) => f.tag === 'button' && hasText(f, 'Generate model'),
    'Generate model',
    '.genbtn',
    40,
  );
  say('  pressing Enter on Generate model...');
  await press(cdp, 'Enter');
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Save as canonical mesh'))`,
    'candidates',
    180_000,
  );
  await focusAfter('the generate run (candidates are up)');

  // ------------------------------------------------------------------- 3 pick
  say('\n## 3 - pick: save r1 as canonical');
  await reach(
    (f) => f.tag === 'button' && hasText(f, 'Save as canonical'),
    'Save as canonical mesh',
    'button.btn.primaryish',
    60,
  );
  await press(cdp, 'Enter');
  // the honest postcondition: the manifest reloads and the rig rail stage is
  // no longer locked (aria-disabled since the rail became reachable-when-locked)
  await waitFor(
    cdp,
    `(() => { const b = [...document.querySelectorAll('nav.rail button')][1]; return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    'the rig stage to unlock',
    120_000,
  );
  await focusAfter('the pick');

  // -------------------------------------------------------------------- 4 rig
  say('\n## 4 - rig: track A, run, accept');
  await reach(
    (f) => f.cls.includes('stage') && hasText(f, '02'),
    'rail stage 02 (rig)',
    'nav.rail button:nth-of-type(2)',
    40,
  );
  await press(cdp, 'Enter');
  await waitFor(
    cdp,
    `[...document.querySelectorAll('[role=radio],button')].some(b => (b.textContent||'').includes('Track A'))`,
    'the rig stage',
    10_000,
  );
  // With the roving contract, only the SELECTED radio is a tab stop - reach
  // the group, then move selection to Track A with the arrow keys.
  await reach((f) => f.role === 'radio', 'the track radiogroup', '[role=radio]', 30);
  for (let hops = 0; hops < 3; hops++) {
    const onTrackA = await evalJs<boolean>(
      cdp,
      `document.activeElement.textContent.includes('Track A')`,
    );
    if (onTrackA) break;
    await press(cdp, 'ArrowRight');
  }
  if (!(await evalJs<boolean>(cdp, `document.activeElement.textContent.includes('Track A')`))) {
    finding('Track A is not reachable with arrow keys inside the track radiogroup');
    await evalJs(
      cdp,
      `[...document.querySelectorAll('[role=radio]')].find(r => r.textContent.includes('Track A'))?.click()`,
    );
  } else if (!(await checked())) {
    await press(cdp, 'Space');
    if (!(await checked())) finding('Track A radio did not select on Space or arrows');
  }
  await reach(
    (f) => f.tag === 'button' && hasText(f, 'Run rig'),
    'Run rig',
    'button.btn.primary',
    20,
  );
  say('  pressing Enter on Run rig...');
  await press(cdp, 'Enter');
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Accept rig'))`,
    'the rig report',
    300_000,
  );
  await focusAfter('the rig run');
  await reach((f) => f.tag === 'button' && hasText(f, 'Accept rig'), 'Accept rig', 'button', 60);
  await press(cdp, 'Enter');
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Unaccept rig'))`,
    'acceptance recorded',
    60_000,
  );
  await focusAfter('accepting the rig');

  // ------------------------------------------------------------------- 5 anim
  say('\n## 5 - anim: enable idle-loop');
  await reach(
    (f) => f.cls.includes('stage') && hasText(f, '03'),
    'rail stage 03 (anim)',
    'nav.rail button:nth-of-type(3)',
    40,
  );
  await press(cdp, 'Enter');
  await waitFor(cdp, `document.querySelector('#clipsearch')`, 'the anim stage', 15_000);
  await reach((f) => f.id === 'clipsearch', 'clip search', '#clipsearch', 40);
  await typeText(cdp, 'idle-loop');
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some(b => b.textContent === 'Enable')`,
    'a filtered Enable button',
    10_000,
  );
  await reach(
    (f) => f.tag === 'button' && f.text === 'Enable',
    'Enable on idle-loop',
    'button',
    20,
  );
  await press(cdp, 'Enter');
  await waitFor(
    cdp,
    `[...document.querySelectorAll('*')].some(e => e.className && String(e.className).includes('bindrow'))`,
    'the binding row',
    60_000,
  );
  await focusAfter('enabling the clip');

  // ------------------------------------------------------------------- 6 look
  say('\n## 6 - look: keep the recorded defaults, verify reachability');
  await reach(
    (f) => f.cls.includes('stage') && hasText(f, '04'),
    'rail stage 04 (look)',
    'nav.rail button:nth-of-type(4)',
    40,
  );
  await press(cdp, 'Enter');
  await waitFor(cdp, `document.querySelector('#lookcam')`, 'the look stage', 15_000);
  await reach((f) => f.id === 'lookcam', 'camera preset select', '#lookcam', 30);
  await reach((f) => f.id === 'lookelev', 'elevation slider', '#lookelev', 10);
  // the slider's keyboard contract: one arrow press moves a USABLE amount
  const evBefore = await evalJs<number>(cdp, `Number(document.activeElement.value)`);
  await press(cdp, 'ArrowUp');
  const evAfter = await evalJs<number>(cdp, `Number(document.activeElement.value)`);
  if (Math.abs(evAfter - evBefore) < 0.1) {
    finding(
      `elevation slider moves ${(evAfter - evBefore).toFixed(3)} deg per arrow press - ` +
        `the range is 0..89, so keyboard traversal needs ~${
          Math.round(89 / Math.max(1e-9, evAfter - evBefore))
        } presses`,
    );
  }
  if (evAfter !== evBefore) await press(cdp, 'ArrowDown'); // put it back
  // the style radiogroup: same contract as the backend cards, restored after
  const styleReached = await reach(
    (f) => f.role === 'radio',
    'a style preset radio',
    '[role=radiogroup] [role=radio]',
    40,
  );
  if (styleReached) {
    await press(cdp, 'ArrowRight');
    const moved = await evalJs<boolean>(
      cdp,
      `document.activeElement?.getAttribute?.('role') === 'radio' && document.activeElement.getAttribute('aria-checked') === 'true'`,
    );
    if (!moved) finding('style radiogroup arrows do not move selection');
    else await press(cdp, 'ArrowLeft'); // restore the recorded style
  }

  // ------------------------------------------------------------------- 7 bake
  say('\n## 7 - bake');
  await reach(
    (f) => f.cls.includes('stage') && hasText(f, '05'),
    'rail stage 05 (bake)',
    'nav.rail button:nth-of-type(5)',
    40,
  );
  await press(cdp, 'Enter');
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some(b => /Bake sheet|Re-bake/.test(b.textContent))`,
    'the bake stage',
    15_000,
  );
  await reach(
    (f) => f.tag === 'button' && (hasText(f, 'Bake sheet') || hasText(f, 'Re-bake')),
    'the Bake button',
    'button.btn.primary',
    30,
  );
  say('  pressing Enter on Bake sheet... (GPU render)');
  await press(cdp, 'Enter');
  await waitFor(cdp, `document.querySelector('#playclip')`, 'the review player', 600_000);
  await focusAfter('the bake');
  await reach(
    (f) => f.tag === 'button' && (hasText(f, 'Pause') || hasText(f, 'Play')),
    'the Play/Pause toggle',
    'button',
    40,
  );
  await press(cdp, 'Enter'); // stop the auto-playing strip

  // ----------------------------------------------------------------- 8 export
  say('\n## 8 - export: godot target');
  await reach(
    (f) => f.cls.includes('stage') && hasText(f, '06'),
    'rail stage 06 (export)',
    'nav.rail button:nth-of-type(6)',
    40,
  );
  await press(cdp, 'Enter');
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Export selected'))`,
    'the export stage',
    10_000,
  );
  await reach(
    (f) => f.tag === 'button' && hasText(f, 'Export selected'),
    'Export selected',
    'button.btn.primary',
    30,
  );
  await press(cdp, 'Enter');
  await waitFor(
    cdp,
    `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Open folder'))`,
    'export artifacts',
    120_000,
  );
  await focusAfter('the export');

  say('\n## Result');
  say(`journey completed; ${findings.length} finding(s):`);
  findings.forEach((f, i) => say(`  ${i + 1}. ${f}`));
  return { trace: lines, findings };
}
