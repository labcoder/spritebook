/** Real WebView2/Tauri bridge check. Launch with an isolated profile and a CDP port first. */
import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Cdp } from './walkthrough.ts';

const [portArg, rootArg, workspaceArg, outArg] = process.argv.slice(2);
assert(
  portArg && rootArg && workspaceArg && outArg,
  'usage: node tools/proofs/desktop-runtime.ts <CDP-port> <roster-root> <workspace> <new-report-directory>',
);
const out = resolve(outArg);
await mkdir(out);
const cdp = await Cdp.connect(Number(portArg));
try {
  const result = await cdp.call('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async()=>{
      const {core,event}=window.__TAURI__;
      const lines=[];
      const stop=await event.listen('cli:desktop-runtime',e=>lines.push(e.payload));
      let code;
      try{code=await core.invoke('run_cli',{jobId:'desktop-runtime',args:['doctor','--json']})}
      finally{await stop()}
      if(code!==0)throw new Error('doctor failed: '+lines.join('\\n'));
      const doctor=JSON.parse(lines[0]);
      if(doctor.node!=='24.22.0'||!doctor.probe?.ok)throw new Error('owned Node/GPU probe failed');
      const root=${JSON.stringify(resolve(rootArg))},dir=${JSON.stringify(resolve(workspaceArg))};
      const rows=await core.invoke('list_workspaces',{root});
      const thumb=await core.invoke('read_thumb',{dir});
      const atlas=await core.invoke('read_bake_atlas',{dir,pass:'lit'});
      const mesh=await core.invoke('read_mesh',{path:dir+'/canonical/model.glb'});
      if(!rows.length||!thumb||!atlas||!mesh)throw new Error('missing core read projection');
      return {doctor,workspaces:rows.length,thumbBytes:atob(thumb).length,atlasKeys:Object.keys(atlas),meshBytes:atob(mesh).length,body:document.body.innerText.slice(0,1600)};
    })()`,
  });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
  await writeFile(`${out}/desktop.png`, Buffer.from(shot.data, 'base64'));
  await writeFile(`${out}/report.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(`Native owned Node/GPU and core read projections passed: ${out}`);
} finally {
  cdp.close();
}
