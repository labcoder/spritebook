import { assertEquals } from 'jsr:@std/assert@1';
import { CONTRACT, PACKAGE } from './mod.ts';

Deno.test('@spritebook/anim stub exports its module-map contract', () => {
  assertEquals(PACKAGE, 'anim');
  assertEquals(typeof CONTRACT, 'string');
});
