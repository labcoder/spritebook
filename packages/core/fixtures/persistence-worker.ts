import { promises as fs } from 'node:fs';
import { pickResult } from '../dist/receipts.js';
import { append } from './state.ts';
const [workspace, mode] = process.argv.slice(2);
if (mode.startsWith('writer-')) {
  for (let i = 0; i < 5; i++) await append(workspace, `${mode}-${i}`);
} else {
  const boundary = mode.replace('asset:', '');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (boundary === 'before-intent' && String(to).endsWith('.pending.json')) process.exit(91);
    await rename(from, to);
    if (String(to).endsWith(boundary)) process.exit(91);
  };
  if (mode.startsWith('asset:')) {
    await pickResult(workspace, 'r2', { canonicalSource: `${workspace}/b.glb` });
  } else await append(workspace, 'new');
}
