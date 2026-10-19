import { assert, assertEquals } from 'jsr:@std/assert@1';
import { runCli } from './mod.ts';

Deno.test('missing and repeated flag values refuse before touching workspaces', async () => {
  const root = await Deno.makeTempDir();
  try {
    for (
      const flags of [
        ['--seed'],
        ['--model', '--json'],
        ['--seed', '1', '--seed', '2'],
        ['--image', ''],
        ['--workspace', `${root}/second`],
      ]
    ) {
      const lines: string[] = [];
      const code = await runCli(['gen', '--workspace', `${root}/hero`, '--json', ...flags], {
        stdout: (line) => lines.push(line),
        stderr: (line) => {
          throw new Error(line);
        },
      });
      assertEquals(code, 1);
      assertEquals(lines.length, 1);
      assertEquals(JSON.parse(lines[0]).code, 'bad-args');
      assert(JSON.parse(lines[0]).message.includes('value'));
      assertEquals(await Array.fromAsync(Deno.readDir(root)), []);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
