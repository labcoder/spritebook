import { assertEquals } from 'jsr:@std/assert@1';
import { CONTRACT, PACKAGE } from './mod.ts';

Deno.test('@spritebook/core stub exports its module-map contract', () => {
  assertEquals(PACKAGE, 'core');
  assertEquals(typeof CONTRACT, 'string');
});
