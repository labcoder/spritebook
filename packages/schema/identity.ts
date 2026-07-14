/**
 * Identity (data-models.ts v0.2): immutable ids, minted at creation.
 * The identity split is a law: `characterId` binds cache keys, file paths and
 * CLI targets and never changes; `displayName` is the only rename target.
 */
import { z } from 'zod';

/** Immutable character slug — binds cache keys, paths, CLI targets. */
export const CharacterIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,40}$/,
    'characterId must be a lowercase slug: /^[a-z0-9][a-z0-9-]{1,40}$/',
  )
  .brand<'CharacterId'>();
export type CharacterId = z.output<typeof CharacterIdSchema>;

const slug = (label: string, max = 64) =>
  z.string().regex(
    new RegExp(`^[a-z0-9][a-z0-9-]{0,${max - 1}}$`),
    `${label} must be a lowercase slug`,
  );

export const ProjectIdSchema = slug('projectId').brand<'ProjectId'>();
export type ProjectId = z.output<typeof ProjectIdSchema>;

export const JobIdSchema = slug('jobId').brand<'JobId'>();
export type JobId = z.output<typeof JobIdSchema>;

/** Short hash id, e.g. "e41c". */
export const BakeIdSchema = z
  .string()
  .regex(/^[0-9a-f]{4,16}$/, 'bakeId must be a short lowercase hex hash')
  .brand<'BakeId'>();
export type BakeId = z.output<typeof BakeIdSchema>;

/** sha256 hex digest. */
export const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex digest (64 chars)');

/** ISO-8601 timestamp (UTC 'Z' or explicit offset). */
export const IsoTimeSchema = z.iso.datetime({ offset: true });
