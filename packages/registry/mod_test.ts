import { assertEquals } from 'jsr:@std/assert@1';
import { CONTRACT, PACKAGE } from './mod.ts';

Deno.test('@spritebook/registry stub exports its module-map contract', () => {
  assertEquals(PACKAGE, 'registry');
  assertEquals(typeof CONTRACT, 'string');
});
