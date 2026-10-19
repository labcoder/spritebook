import { promises as fs } from 'node:fs';
/**
 * Run the full-journey keyboard-only walkthrough against the running desktop
 * app and record the transcript to docs/internal/proofs/walkthrough.md.
 *
 * Launch the app with the debug port first:
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run dev:desktop
 * then:
 *   node tools/run.mjs tools/proofs/walkthrough_journey.ts
 *
 * The journey itself lives in journey.ts so the gated regression test
 * (walkthrough_test.ts) runs the exact same steps.
 */
import { Cdp } from './walkthrough.ts';
import { runJourney } from './journey.ts';

const ROOT = 'C:\\dev\\Mighty\\tools\\spritebook\\.proof-ux\\projects';
const IMAGE = 'C:\\dev\\Mighty\\tools\\spritebook\\tests\\fixtures\\bulma-front.png';
const NAME = process.argv.slice(2)[0] ?? 'kb-hero';

const cdp = await Cdp.connect(
  Number(process.env['SPRITEBOOK_CDP_PORT'] ?? '9223'),
);
const { trace, findings } = await runJourney(cdp, {
  root: ROOT,
  image: IMAGE,
  name: NAME,
  log: (s) => console.log(s),
});

await fs.writeFile(
  'docs/internal/proofs/walkthrough.md',
  `# Full-journey keyboard-only walkthrough\n\nCaptured ${
    new Date().toISOString()
  } by \`tools/proofs/walkthrough_journey.ts\` against the running desktop app; ` +
    'regenerate rather than hand-editing.\n\n```\n' + trace.join('\n') +
    '\n```\n',
);
console.log('\nrecorded to docs/internal/proofs/walkthrough.md');
cdp.close();
process.exit(findings.length === 0 ? 0 : 1);
