import { assertEquals } from 'jsr:@std/assert@1';
import { CONTRACT, PACKAGE } from './mod.ts';

Deno.test('@spritebook/pack stub exports its module-map contract', () => {
  assertEquals(PACKAGE, 'pack');
  assertEquals(typeof CONTRACT, 'string');
});
