import { assertEquals } from 'jsr:@std/assert@1';
import { CONTRACT, PACKAGE } from './mod.ts';

Deno.test('@spritebook/export stub exports its module-map contract', () => {
  assertEquals(PACKAGE, 'export');
  assertEquals(typeof CONTRACT, 'string');
});
