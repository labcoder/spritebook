import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function extractArchive(archive: string, destination: string): void {
  let tar = 'tar';
  if (process.platform === 'win32') {
    assert(process.env.SystemRoot, 'SystemRoot is required to locate Windows tar');
    // Git/MSYS tar treats a Windows drive letter as a remote-host prefix.
    tar = join(process.env.SystemRoot, 'System32', 'tar.exe');
  }
  execFileSync(tar, ['-xf', archive, '-C', destination], { windowsHide: true });
}
