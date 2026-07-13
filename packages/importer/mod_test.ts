import { assertEquals } from 'jsr:@std/assert@1';
import { CONTRACT, PACKAGE } from './mod.ts';

Deno.test('@spritebook/importer stub exports its module-map contract', () => {
  assertEquals(PACKAGE, 'importer');
  assertEquals(typeof CONTRACT, 'string');
});
