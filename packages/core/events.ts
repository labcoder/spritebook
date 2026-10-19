import { closeSync, openSync, writeSync } from 'node:fs';
/**
 * The NDJSON emitter — one JobEvent per line, matching @spritebook/schema
 * EXACTLY (every emitted event is validated; every line is canonical JSON).
 * The GUI log drawer renders this stream verbatim: what CI sees is what users
 * see (architecture, "Event & diagnostics contract").
 */
import { canonicalJson, type JobEvent, JobEventSchema, parseWith } from '@spritebook/schema';

/** Validate + serialize one event as a canonical NDJSON line (with '\n'). */
export function encodeEvent(event: JobEvent): string {
  return canonicalJson(parseWith(JobEventSchema, event, 'JobEvent'));
}

/** Parse + validate one NDJSON line back into a JobEvent. */
export function decodeEvent(line: string): JobEvent {
  return parseWith(JobEventSchema, JSON.parse(line), 'JobEvent line');
}

export type EventListener = (event: JobEvent) => void;

export interface EventSink {
  write(line: string): void;
  close(): void;
}

/** Append-only NDJSON file sink (the optional session log file, audit 11). */
export class FileSink implements EventSink {
  #file: number | undefined;

  constructor(path: string | URL) {
    this.#file = openSync(path, 'a');
  }

  write(line: string): void {
    if (this.#file === undefined) throw new Error('Event sink is closed.');
    writeSync(this.#file, line);
  }

  close(): void {
    if (this.#file !== undefined) {
      closeSync(this.#file);
      this.#file = undefined;
    }
  }
}

/** Fixed-capacity session ring buffer — the log drawer's in-memory source. */
export class RingBuffer {
  #buf: JobEvent[] = [];
  #capacity: number;

  constructor(capacity = 1000) {
    if (capacity < 1) throw new Error('ring capacity must be >= 1');
    this.#capacity = capacity;
  }

  push(event: JobEvent): void {
    this.#buf.push(event);
    if (this.#buf.length > this.#capacity) this.#buf.shift();
  }

  /** Oldest -> newest. */
  snapshot(): JobEvent[] {
    return [...this.#buf];
  }

  get size(): number {
    return this.#buf.length;
  }
}

/**
 * EventBus: the single choke point every event passes through — validated,
 * ring-buffered, optionally file-sunk, and fanned out to listeners.
 */
export class EventBus {
  readonly ring: RingBuffer;
  #sink?: EventSink;
  #listeners = new Set<EventListener>();

  constructor(opts: { ringCapacity?: number; sink?: EventSink } = {}) {
    this.ring = new RingBuffer(opts.ringCapacity ?? 1000);
    this.#sink = opts.sink;
  }

  emit(event: JobEvent): void {
    const line = encodeEvent(event); // validates; throws on contract violations
    this.ring.push(event);
    this.#sink?.write(line);
    for (const l of this.#listeners) l(event);
  }

  listen(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#sink?.close();
  }
}
