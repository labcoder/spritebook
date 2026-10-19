// F2 experiment only: execute unchanged Deno modules. Delete during the F4 API port.
import * as fs from 'node:fs/promises';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

class NotFound extends Error {
  static [Symbol.hasInstance](error) {
    return error?.code === 'ENOENT';
  }
}

globalThis.require = createRequire(import.meta.url);
globalThis.Deno = new Proxy({
  args: process.argv.slice(2),
  env: { get: (name) => process.env[name] },
  build: { os: process.platform === 'win32' ? 'windows' : process.platform },
  errors: { NotFound },
  noColor: true,
  // Deno's byteOffset is zero; Buffer's pooled backing store breaks existing poses readers.
  readFile: async (path) => new Uint8Array(await fs.readFile(path)),
  readTextFile: (path) => fs.readFile(path, 'utf8'),
  readTextFileSync: (path) => readFileSync(path, 'utf8'),
  writeFile: fs.writeFile,
  writeTextFile: (path, text) => fs.writeFile(path, text, 'utf8'),
  mkdir: fs.mkdir,
  mkdirSync,
  rename: fs.rename,
  remove: fs.rm,
  makeTempDir: (options = {}) => fs.mkdtemp(join(tmpdir(), options.prefix ?? 'spritebook-f2-')),
  stat: async (path) => {
    const stat = await fs.stat(path);
    return { size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory() };
  },
}, {
  get(target, name) {
    if (name in target) return target[name];
    throw new Error(`F2 adapter does not implement Deno.${String(name)}; this is not a core port`);
  },
});
