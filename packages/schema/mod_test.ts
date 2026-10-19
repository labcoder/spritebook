import { test } from 'node:test';
import { assertEquals } from '@std/assert';
import { JOB_EVENT_TYPES } from './dist/mod.js';

test('job-event vocabulary matches the architecture contract, in order', () => {
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
