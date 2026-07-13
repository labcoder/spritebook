/**
 * @spritebook/schema - the single typed truth for every manifest and contract.
 *
 * P1-T1 seed: only the job-event vocabulary lives here so downstream stubs can
 * compile against the real NDJSON contract. P1-T2 replaces this with the full
 * validated v0.2 data model (see docs/architecture/data-models.ts and
 * docs/internal/roadmap/p1.md).
 */

/** NDJSON job-event vocabulary - order matters and is part of the contract. */
export const JOB_EVENT_TYPES = [
  'queued',
  'started',
  'progress',
  'artifact',
  'warn',
  'error',
  'done',
] as const;

export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

interface JobEventBase {
  event: JobEventType;
  jobId: string;
  /** ISO-8601 timestamp */
  ts: string;
}

export interface JobQueuedEvent extends JobEventBase {
  event: 'queued';
}

export interface JobStartedEvent extends JobEventBase {
  event: 'started';
  verb: string;
}

export interface JobProgressEvent extends JobEventBase {
  event: 'progress';
  pct: number;
  message?: string;
}

export interface JobArtifactEvent extends JobEventBase {
  event: 'artifact';
  /** artifacts are files on disk - pixels never travel through events */
  path: string;
  kind: string;
}

export interface JobWarnEvent extends JobEventBase {
  event: 'warn';
  message: string;
}

export interface JobErrorEvent extends JobEventBase {
  event: 'error';
  message: string;
  retryable: boolean;
}

export interface JobDoneEvent extends JobEventBase {
  event: 'done';
  ok: boolean;
}

export type JobEvent =
  | JobQueuedEvent
  | JobStartedEvent
  | JobProgressEvent
  | JobArtifactEvent
  | JobWarnEvent
  | JobErrorEvent
  | JobDoneEvent;
