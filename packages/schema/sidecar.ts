/**
 * Sidecar wire contract (P3-T2; architecture.md "Sidecar contract"). The
 * Python sidecar is a LOCAL, per-session process owned by core. Everything
 * that crosses the boundary is validated by these schemas on the core side;
 * the sidecar mirrors the constants and shapes in Python.
 *
 * ## The contract, frozen
 *
 * - **Spawn**: core launches the sidecar (uv-run project) with the auth token
 *   in the `SPRITEBOOK_SIDECAR_TOKEN` env var and `--port 0` (ephemeral) or an
 *   explicit port. The sidecar binds **127.0.0.1 only** — never 0.0.0.0.
 * - **Startup**: the sidecar prints EXACTLY ONE line to stdout — the
 *   `SidecarListening` JSON — then never writes stdout again (logs go to
 *   stderr). Core reads that line to learn the bound port.
 * - **Auth**: every request carries `Authorization: Bearer <token>`; anything
 *   else is 401. The token exists so another local process cannot drive the
 *   sidecar; it is minted fresh per session and never persisted.
 * - **GET /handshake** -> 200 `SidecarHandshake`. Core REFUSES to proceed when
 *   `contractVersion !== SIDECAR_CONTRACT_VERSION` (actionable error naming
 *   both versions), and learns the adapter roster (each with its
 *   `paramsSchema`, which core validates params against BEFORE submitting —
 *   an invalid-params job never reaches the sidecar).
 * - **POST /jobs** with `SidecarJobRequest` -> 200 chunked NDJSON: one
 *   `JobEvent` (jobs.ts vocabulary, same `jobId`) per line, ending with a
 *   terminal `done` or `error` event, then the stream closes. Artifacts are
 *   file PATHS under the request's work dir — pixels never travel through
 *   events (D-004 discipline at this seam too).
 * - **POST /shutdown** -> 202, then graceful exit. Core's supervisor uses it
 *   for clean disposal and falls back to killing the process.
 * - **Death**: a stream that ends without a terminal event, a refused
 *   connection, or a dead process all surface core-side as an `error` event
 *   with `retryable: true` — the supervisor respawns on the next attempt
 *   (sidecar-vram skill: design for the sidecar dying, because it will).
 */
import { z } from 'zod';
import { JobIdSchema } from './identity.ts';
import { JsonSchemaSchema } from './registry.ts';

/** Bumped on any breaking change to endpoints, shapes, or semantics above. */
export const SIDECAR_CONTRACT_VERSION = 1;

/** Env var the token travels in (never argv — argv is world-readable). */
export const SIDECAR_TOKEN_ENV = 'SPRITEBOOK_SIDECAR_TOKEN';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

/** The single stdout line announcing the bound port. */
export const SidecarListeningSchema = z.strictObject({
  t: z.literal('listening'),
  port: z.int().min(1).max(65535),
  pid: z.int().positive(),
});
export type SidecarListening = z.output<typeof SidecarListeningSchema>;

/** One runnable adapter as announced by the handshake. `kind` matches the
 * registry's ModelEntry kinds, plus 'test' for the built-in echo adapter. */
export const SidecarAdapterSchema = z.strictObject({
  id: slug,
  kind: z.enum(['imageprep', 'gen3d', 'rig', 'test']),
  version: z.string().min(1),
  /** validates job params core-side AND drives GUI option forms (D-009) */
  paramsSchema: JsonSchemaSchema,
  defaults: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
});
export type SidecarAdapter = z.output<typeof SidecarAdapterSchema>;

export const SidecarHandshakeSchema = z.strictObject({
  contractVersion: z.int().positive(),
  sidecarVersion: z.string().min(1),
  python: z.string().min(1),
  adapters: z.array(SidecarAdapterSchema),
});
export type SidecarHandshake = z.output<typeof SidecarHandshakeSchema>;

export const SidecarJobRequestSchema = z.strictObject({
  jobId: JobIdSchema,
  /** adapter id from the handshake roster */
  kind: slug,
  /** validated against the adapter's paramsSchema BEFORE this request exists */
  params: z.record(z.string(), z.unknown()),
});
export type SidecarJobRequest = z.output<typeof SidecarJobRequestSchema>;
