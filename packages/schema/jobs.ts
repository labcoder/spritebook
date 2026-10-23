/**
 * Jobs & events — the NDJSON contract. The log drawer
 * renders this stream verbatim; CI sees exactly what users see.
 *
 * Supersedes the P1-T1 seed shape: field names are `t`/`at` per the contract
 * of record, and each variant carries its own payload.
 */
import { z } from 'zod';
import { CharacterIdSchema, IsoTimeSchema, JobIdSchema } from './identity.ts';

export const JOB_VERBS = [
  'import',
  'prep',
  'gen',
  'pick',
  'rig',
  'anim',
  'bake',
  'export',
  'models',
  'extensions',
] as const;

export const JobSpecSchema = z.strictObject({
  jobId: JobIdSchema,
  verb: z.enum(JOB_VERBS),
  characterId: CharacterIdSchema.optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type JobSpec = z.output<typeof JobSpecSchema>;

/** Event vocabulary — order matters and is part of the contract. */
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

const base = { jobId: JobIdSchema, at: IsoTimeSchema };

export const JobEventSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('queued'), ...base }),
  z.strictObject({ t: z.literal('started'), ...base }),
  z.strictObject({
    t: z.literal('progress'),
    ...base,
    step: z.string().min(1),
    done: z.int().nonnegative(),
    total: z.int().positive(),
  }),
  z.strictObject({
    t: z.literal('artifact'),
    ...base,
    kind: z.string().min(1),
    /** artifacts are files on disk — pixels never travel through events */
    path: z.string().min(1),
  }),
  z.strictObject({
    t: z.literal('warn'),
    ...base,
    code: z.string().min(1),
    message: z.string().min(1),
  }),
  z.strictObject({
    t: z.literal('error'),
    ...base,
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
  z.strictObject({ t: z.literal('done'), ...base, wallTimeS: z.number().nonnegative() }),
]);
export type JobEvent = z.output<typeof JobEventSchema>;
