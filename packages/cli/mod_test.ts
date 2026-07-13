import { assertEquals } from 'jsr:@std/assert@1';
import { CONTRACT, PACKAGE } from './mod.ts';

Deno.test('@spritebook/cli stub exports its module-map contract', () => {
  assertEquals(PACKAGE, 'cli');
  assertEquals(typeof CONTRACT, 'string');
});
