import { assertEquals } from 'jsr:@std/assert@1';
import { JOB_EVENT_TYPES } from './mod.ts';

Deno.test('job-event vocabulary matches the architecture contract, in order', () => {
  // docs/architecture/architecture.md - "Jobs emit NDJSON: queued | started |
  // progress | artifact | warn | error | done"
  assertEquals(JOB_EVENT_TYPES, [
    'queued',
    'started',
    'progress',
    'artifact',
    'warn',
    'error',
    'done',
  ]);
});
