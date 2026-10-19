import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchToFile } from './dist/mod.js';

test('Hub authentication stays on its HTTPS origin across CDN redirects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sb-hub-auth-'));
  const saved = {
    HF_TOKEN: process.env.HF_TOKEN,
    HF_TOKEN_PATH: process.env.HF_TOKEN_PATH,
    HF_HUB_DISABLE_IMPLICIT_TOKEN: process.env.HF_HUB_DISABLE_IMPLICIT_TOKEN,
  };
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true });
  });
  delete process.env.HF_TOKEN;
  delete process.env.HF_HUB_DISABLE_IMPLICIT_TOKEN;
  process.env.HF_TOKEN_PATH = join(root, 'token');
  await writeFile(process.env.HF_TOKEN_PATH, 'test-only-token\n');
  const calls: { url: string; auth: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', (url: URL, options: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(options.headers).get('authorization') });
    return Promise.resolve(
      url.hostname === 'huggingface.co'
        ? new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.invalid/weight' },
        })
        : new Response('verified-by-the-installer'),
    );
  });
  await fetchToFile('https://huggingface.co/owner/model/resolve/pin/file', join(root, 'weight'));
  assert.deepEqual(calls.map((call) => call.auth), ['Bearer test-only-token', null]);
  assert.equal(await readFile(join(root, 'weight'), 'utf8'), 'verified-by-the-installer');
  calls.length = 0;
  await fetchToFile('https://huggingface.co.evil.invalid/weight', join(root, 'other'));
  assert.equal(calls[0].auth, null);
  process.env.HF_TOKEN = 'private\nvalue';
  const sent = calls.length;
  await assert.rejects(
    fetchToFile('https://huggingface.co/model', join(root, 'invalid')),
    (error: Error) =>
      /Invalid Hugging Face token format/.test(error.message) && !error.message.includes('private'),
  );
  assert.equal(calls.length, sent, 'Invalid credentials never reach fetch or its error formatting');
});
