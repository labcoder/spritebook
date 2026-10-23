import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
/**
 * Run the full-journey keyboard-only walkthrough against the running desktop
 * app and record the transcript to docs/internal/proofs/walkthrough.md.
 *
 * Launch the app with the debug port first:
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run dev:desktop
 * then:
 *   node tools/run.mjs tools/proofs/walkthrough_journey.ts kb-hero path/to/reference.png
 *
 * The journey itself lives in journey.ts so the gated regression test
 * (walkthrough_test.ts) runs the exact same steps.
 */
import { Cdp } from './walkthrough.ts';
import { runJourney } from './journey.ts';

const ROOT = resolve('.proof-ux/projects');
const NAME = process.argv.slice(2)[0] ?? 'kb-hero';
const imageArg = process.argv.slice(2)[1];
if (!imageArg) throw new Error('Provide a reference image after the character name');
const IMAGE = resolve(imageArg);

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
