import { test } from 'node:test';
/**
 * The slug preview vs core's CharacterIdSchema: the studio mirrors the rule
 * for live feedback, and this test CROSS-CHECKS every sample against the
 * real schema so the mirror can never drift silently. Runs under the root
 * npm workspace, so @spritebook/schema resolves.
 */
import { assert, assertEquals } from '@std/assert';
import { CharacterIdSchema } from '@spritebook/schema';
import { CHARACTER_ID_RE, slugify, slugProblem } from './src/slug.ts';

const NAMES = [
  'Bulma',
  'bulma-fixed',
  'The  Mermaid!!',
  "princess's dress",
  '  padded  ',
  'Ñandú Runner',
  'cc',
  'c',
  '-leading-dash',
  'UPPER_case_name',
  'x'.repeat(60),
  '日本語の名前',
  '99 red balloons',
];

test('every minted slug the preview calls valid IS valid to core', () => {
  for (const name of NAMES) {
    const slug = slugify(name);
    const preview = slugProblem(slug);
    const core = CharacterIdSchema.safeParse(slug).success;
    assertEquals(
      preview === null,
      core,
      `"${name}" -> "${slug}": preview says ${preview ?? 'valid'}, core says ${
        core ? 'valid' : 'invalid'
      }`,
    );
  }
});

test('the mirrored regex IS the schema regex, character for character', () => {
  // the schema's error message quotes its regex — compare source to source,
  // so a core rule change fails HERE before it ships a lying preview
  const probe = CharacterIdSchema.safeParse('!');
  assert(!probe.success);
  const message = JSON.stringify(probe.error?.issues ?? []);
  assert(
    message.includes(CHARACTER_ID_RE.source),
    `core's rule no longer matches the mirror: ${CHARACTER_ID_RE.source} not in ${message}`,
  );
});

test('minting normalizes the way a user expects', () => {
  assertEquals(slugify('Bulma'), 'bulma');
  assertEquals(slugify('The  Mermaid!!'), 'the-mermaid');
  assertEquals(slugify("princess's dress"), 'princesss-dress');
  assertEquals(slugify('UPPER_case_name'), 'upper-case-name');
  assertEquals(slugify('  padded  '), 'padded');
  assert(slugify('x'.repeat(60)).length <= 41, 'clipped to the schema max');
  assertEquals(slugProblem(slugify('c')), 'ids need at least 2 characters');
  assertEquals(slugProblem(slugify('日本語の名前')), 'a name is required');
});
