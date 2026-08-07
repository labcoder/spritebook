/**
 * A mechanical ASD-STE100 linter for the shipped docs (P4-T4).
 *
 * STE conformance is mostly judgement, but three rules are countable, and the
 * countable ones are where drafts drift first:
 *
 *   1. sentence length - max 20 words in a numbered step (procedural), max
 *      25 elsewhere (descriptive)
 *   2. banned words - the substitution list's "do not use" column
 *   3. paragraph length - max 6 sentences
 *
 * What this deliberately does NOT check: the approved-dictionary rule (the
 * official dictionary is copyrighted and not bundled), gerund-as-noun
 * detection (needs a parser; reviewers catch it), and passive voice (heuristics
 * flag technical names like "is baked" that the docs legitimately need as
 * past-participle adjectives). A clean run here is NECESSARY, not sufficient.
 *
 * Code spans, fenced blocks, tables, headings, and link targets are exempt:
 * command lines and file paths are technical names, not prose.
 *
 * Run: deno run --allow-read tools/docs/ste-lint.ts docs/guide.md docs/engines/*.md
 */

const BANNED: Record<string, string> = {
  accomplish: 'do',
  execute: 'do',
  perform: 'do',
  acquire: 'get',
  obtain: 'get',
  procure: 'get',
  ascertain: 'find',
  attempt: 'try',
  cease: 'stop',
  terminate: 'stop',
  discontinue: 'stop',
  commence: 'start',
  initiate: 'start',
  endeavor: 'try',
  ensure: 'make sure',
  facilitate: 'help',
  illuminate: 'come on',
  indicate: 'show',
  locate: 'find',
  modify: 'change',
  observe: 'look at',
  permit: 'let',
  purchase: 'buy',
  rectify: 'correct',
  remedy: 'correct',
  replenish: 'fill',
  require: 'need',
  retain: 'keep',
  transmit: 'send',
  utilize: 'use',
  verify: 'make sure',
  aperture: 'hole',
  assistance: 'help',
  commencement: 'start',
  malfunction: 'fault',
  personnel: 'persons',
  portion: 'part',
  remainder: 'the other part',
  requirement: 'need',
  utilization: 'use',
  vicinity: 'area',
  adequate: 'enough',
  sufficient: 'enough',
  adjacent: 'near',
  approximately: 'about',
  additional: 'more',
  numerous: 'many',
  optimum: 'best',
  rapidly: 'quickly',
  subsequent: 'after',
  subsequently: 'after',
  'prior to': 'before',
  'in order to': 'to',
  'in the event that': 'if',
  'due to the fact that': 'because',
  'at this time': 'now',
  'a number of': 'some',
  'is capable of': 'can',
  'in conjunction with': 'with',
  'with regard to': 'about',
  'for the purpose of': 'to',
  'in accordance with': 'as in',
  'in the vicinity of': 'near',
  'it is necessary to': 'you must',
};

interface Hit {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

/** Strip the spans the rules exempt, keeping line structure. */
function stripExempt(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' ')) // fenced blocks
    .replace(/`[^`\n]*`/g, ' ') // inline code
    .replace(/\]\([^)]*\)/g, ']') // link targets
    .replace(/^\|.*\|$/gm, '') // table rows
    .replace(/^#+ .*$/gm, ''); // headings
}

function lint(file: string, raw: string): Hit[] {
  const hits: Hit[] = [];
  const text = stripExempt(raw);
  const lines = text.split('\n');

  // sentence length, per line-block so we can attribute a line number
  let paraSentences = 0;
  let paraStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      if (paraSentences > 6) {
        hits.push({
          file,
          line: paraStart + 1,
          rule: 'paragraph>6-sentences',
          detail: `${paraSentences} sentences in one paragraph`,
        });
      }
      paraSentences = 0;
      paraStart = i + 1;
      continue;
    }
    const procedural = /^\s*\d+[.)]\s/.test(line);
    // A LIST ITEM is not a paragraph sentence. Rule 4.3 REQUIRES a list once
    // there are more than three related items, so counting its items against
    // the six-sentence paragraph limit (4.1) punishes the rule it enforces -
    // the linter's first run flagged the bake player's own control list.
    const listItem = /^\s*([-*+]|\d+[.)])\s/.test(line);
    const max = procedural ? 20 : 25;
    // sentences on this line; abbreviations like "e.g." are not used in STE docs
    for (const s of line.split(/(?<=[.!?])\s+/)) {
      const words = s.trim().split(/\s+/).filter((w) => /\w/.test(w));
      if (words.length === 0) continue;
      if (/[.!?]$/.test(s.trim()) && !listItem) paraSentences++;
      if (words.length > max) {
        hits.push({
          file,
          line: i + 1,
          rule: procedural ? 'step>20-words' : 'sentence>25-words',
          detail: `${words.length} words: "${s.trim().slice(0, 60)}..."`,
        });
      }
    }
    // banned vocabulary (word-boundary, case-insensitive)
    const low = line.toLowerCase();
    for (const [bad, good] of Object.entries(BANNED)) {
      const re = new RegExp(`\\b${bad.replace(/ /g, '\\s+')}\\b`, 'i');
      if (re.test(low)) {
        hits.push({ file, line: i + 1, rule: 'banned-word', detail: `"${bad}" -> use "${good}"` });
      }
    }
  }
  return hits;
}

const files = Deno.args;
if (files.length === 0) {
  console.error('usage: ste-lint.ts <file.md> [...]');
  Deno.exit(2);
}
let total = 0;
for (const f of files) {
  const hits = lint(f, await Deno.readTextFile(f));
  total += hits.length;
  for (const h of hits) console.log(`${h.file}:${h.line} [${h.rule}] ${h.detail}`);
}
console.log(total === 0 ? 'STE lint: clean' : `STE lint: ${total} finding(s)`);
Deno.exit(total === 0 ? 0 : 1);
