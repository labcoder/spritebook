import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { test } from 'node:test';
/**
 * Protocol tests for the sidecar CLIENT against a mock server speaking the
 * frozen wire contract — Node HTTP, no Python. The real-process tests
 * (spawn, kill-mid-job, respawn-on-retry) live in the P3-T2 integration
 * suite, gated on uv; these pin the client's half of the contract:
 * the params gate fires BEFORE any HTTP, auth is always sent, invalid
 * server lines and mid-stream death classify correctly.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { JobEvent, JobId, SidecarAdapter } from '@spritebook/schema';
import { SIDECAR_CONTRACT_VERSION } from '@spritebook/schema';
import { connectSidecar, runSidecarJob } from './dist/sidecar.js';
import { validateParams, withDefaults } from './dist/params.js';

const JOB = 'test-job' as JobId;

const ECHO: SidecarAdapter = {
  id: 'echo',
  kind: 'test',
  version: '0.1.0',
  paramsSchema: {
    type: 'object',
    required: ['steps'],
    properties: {
      steps: { type: 'integer', minimum: 1 },
      delayMs: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  defaults: { delayMs: 0 },
};

interface MockOpts {
  contractVersion?: number;
  /** lines the /jobs route streams; '<CUT>' = close the stream right there */
  jobLines?: (jobId: string) => string[];
  onJobBody?: (body: unknown) => void;
}

/** A mock sidecar speaking the wire contract on 127.0.0.1:ephemeral. */
function mockSidecar(token: string, opts: MockOpts = {}) {
  let jobRequests = 0;
  const ready = Promise.withResolvers<number>();
  const ev = (e: Record<string, unknown>) => JSON.stringify({ at: new Date().toISOString(), ...e });
  const handle = async (req: Request) => {
      if (req.headers.get('authorization') !== `Bearer ${token}`) {
        return new Response('{"error":"unauthorized"}', { status: 401 });
      }
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/handshake') {
        return Response.json({
          contractVersion: opts.contractVersion ?? SIDECAR_CONTRACT_VERSION,
          sidecarVersion: '0.1.0-mock',
          python: '3.11.0',
          adapters: [ECHO],
        });
      }
      if (req.method === 'POST' && url.pathname === '/jobs') {
        jobRequests++;
        const body = await req.json();
        opts.onJobBody?.(body);
        const lines = opts.jobLines?.(body.jobId) ?? [
          ev({ t: 'queued', jobId: body.jobId }),
          ev({ t: 'started', jobId: body.jobId }),
          ev({ t: 'progress', jobId: body.jobId, step: 'echo', done: 1, total: 1 }),
          ev({ t: 'done', jobId: body.jobId, wallTimeS: 0.01 }),
        ];
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            for (const line of lines) {
              if (line === '<CUT>') break;
              controller.enqueue(enc.encode(line + '\n'));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }
      return new Response('{"error":"not found"}', { status: 404 });
    };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        body: incoming.method === 'GET' ? undefined : Readable.toWeb(incoming),
        duplex: 'half',
      } as RequestInit);
      const response = await handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { outgoing.destroy(error as Error); }
  });
  server.listen(0, '127.0.0.1', () => ready.resolve((server.address() as AddressInfo).port));
  return {
    port: ready.promise,
    jobRequests: () => jobRequests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function collect(it: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test('handshake: validates, learns the roster, sends auth', async () => {
  const mock = mockSidecar('tok-a');
  const port = await mock.port;
  try {
    const hs = await connectSidecar({ port, token: 'tok-a' });
    assertEquals(hs.adapters.map((a) => a.id), ['echo']);
    await assertRejects(
      () => connectSidecar({ port, token: 'WRONG' }),
      Error,
      '401',
    );
  } finally {
    await mock.close();
  }
});

test('handshake: contract version mismatch is refused, naming both', async () => {
  const mock = mockSidecar('tok-b', { contractVersion: 99 });
  const port = await mock.port;
  try {
    const err = await assertRejects(() => connectSidecar({ port, token: 'tok-b' }), Error);
    assert(err.message.includes('v99'), err.message);
    assert(err.message.includes(`v${SIDECAR_CONTRACT_VERSION}`), err.message);
  } finally {
    await mock.close();
  }
});

test('params gate: unknown adapter and invalid params never reach the sidecar', async () => {
  const mock = mockSidecar('tok-c');
  const port = await mock.port;
  try {
    const endpoint = { port, token: 'tok-c', adapters: [ECHO] };

    const unknown = await collect(
      runSidecarJob(endpoint, { jobId: JOB, kind: 'nope', params: {} }),
    );
    assertEquals(unknown.length, 1);
    assert(unknown[0].t === 'error' && unknown[0].code === 'unknown-adapter');
    assert(unknown[0].t === 'error' && unknown[0].message.includes('echo'), 'lists the roster');

    const invalid = await collect(
      runSidecarJob(endpoint, { jobId: JOB, kind: 'echo', params: { steps: 'three' } }),
    );
    assertEquals(invalid.length, 1);
    assert(invalid[0].t === 'error' && invalid[0].code === 'invalid-params');
    assert(invalid[0].t === 'error' && !invalid[0].retryable, 'bad params are not retryable');

    // the roadmap acceptance, core half: NOTHING hit the wire
    assertEquals(mock.jobRequests(), 0, 'sidecar never saw the invalid jobs');
  } finally {
    await mock.close();
  }
});

test('job stream: events validate, defaults merge under explicit params', async () => {
  let seenBody: { params?: Record<string, unknown> } = {};
  const mock = mockSidecar('tok-d', { onJobBody: (b) => (seenBody = b as typeof seenBody) });
  const port = await mock.port;
  try {
    const events = await collect(
      runSidecarJob({ port, token: 'tok-d', adapters: [ECHO] }, {
        jobId: JOB,
        kind: 'echo',
        params: { steps: 2 },
      }),
    );
    assertEquals(events.map((e) => e.t), ['queued', 'started', 'progress', 'done']);
    assertEquals(seenBody.params, { steps: 2, delayMs: 0 }, 'defaults merged and validated');
  } finally {
    await mock.close();
  }
});

test('death rule: stream ending without a terminal event -> retryable sidecar-died', async () => {
  const mock = mockSidecar('tok-e', {
    jobLines: (jobId) => [
      JSON.stringify({ t: 'queued', jobId, at: new Date().toISOString() }),
      JSON.stringify({ t: 'started', jobId, at: new Date().toISOString() }),
      '<CUT>',
    ],
  });
  const port = await mock.port;
  try {
    const events = await collect(
      runSidecarJob({ port, token: 'tok-e', adapters: [ECHO] }, {
        jobId: JOB,
        kind: 'echo',
        params: { steps: 1 },
      }),
    );
    assertEquals(events.map((e) => e.t), ['queued', 'started', 'error']);
    const last = events.at(-1)!;
    assert(last.t === 'error' && last.code === 'sidecar-died' && last.retryable === true);
  } finally {
    await mock.close();
  }
});

test('protocol rule: an invalid event line is a non-retryable protocol error', async () => {
  const mock = mockSidecar('tok-f', {
    jobLines: (jobId) => [
      JSON.stringify({ t: 'queued', jobId, at: new Date().toISOString() }),
      '{"t":"progress","garbage":true}',
    ],
  });
  const port = await mock.port;
  try {
    const events = await collect(
      runSidecarJob({ port, token: 'tok-f', adapters: [ECHO] }, {
        jobId: JOB,
        kind: 'echo',
        params: { steps: 1 },
      }),
    );
    const last = events.at(-1)!;
    assert(last.t === 'error' && last.code === 'sidecar-protocol' && !last.retryable);
  } finally {
    await mock.close();
  }
});

test('death rule: connection refused -> retryable sidecar-died', async () => {
  // bind-then-close to get a port with no listener
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const events = await collect(
    runSidecarJob({ port, token: 't', adapters: [ECHO] }, {
      jobId: JOB,
      kind: 'echo',
      params: { steps: 1 },
    }),
  );
  assertEquals(events.length, 1);
  assert(events[0].t === 'error' && events[0].code === 'sidecar-died' && events[0].retryable);
});

test('validateParams: strict, allErrors, actionable messages', () => {
  const bad = validateParams(ECHO.paramsSchema, { steps: 0, extra: 1 });
  assert(!bad.ok);
  if (!bad.ok) {
    assert(bad.errors.some((e) => e.includes('steps')), bad.errors.join('; '));
    // "actionable" means NAMING the key: this used to accept ajv's own "must
    // NOT have additional properties", which never says which one (params_test)
    assert(bad.errors.some((e) => e.includes('unknown param(s) extra')), bad.errors.join('; '));
  }
  assert(validateParams(ECHO.paramsSchema, withDefaults(ECHO.defaults, { steps: 3 })).ok);
});

test('validateParams: a malformed SCHEMA is an error result, never a throw', () => {
  // the schema arrives from the sidecar handshake (arbitrary JSON record) —
  // an ajv-strict rejection must not detonate the choke point (review P2-2)
  for (
    const garbage of [
      { type: 'objekt' },
      { type: 'object', properties: { a: { type: 'object', notAKeyword: 1 } } },
      { required: 'steps' },
    ]
  ) {
    const r = validateParams(garbage as never, {});
    assert(!r.ok, `schema ${JSON.stringify(garbage)} must fail closed`);
    if (!r.ok) assert(r.errors[0].includes('invalid paramsSchema'), r.errors[0]);
  }
});
