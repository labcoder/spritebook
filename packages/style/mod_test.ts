import { assertEquals } from 'jsr:@std/assert@1';
import { CONTRACT, PACKAGE } from './mod.ts';

Deno.test('@spritebook/style stub exports its module-map contract', () => {
  assertEquals(PACKAGE, 'style');
  assertEquals(typeof CONTRACT, 'string');
});
