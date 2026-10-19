/** F1-T3: real Editor mount in the desktop WebView; delayed jobs prove stale-completion guards.
 * Launch the dev shell with WebView2 CDP, then:
 * deno run --allow-net=127.0.0.1 --allow-read --allow-write tools/proofs/editor-ownership.ts 9224
 * Native descendant death is covered by cargo test; this proof injects delayed bridge responses.
 */
import { Cdp } from './walkthrough.ts';
import { fileURLToPath } from 'node:url';
const c = await Cdp.connect(Number(Deno.args[0] ?? 9224));
const root = await Deno.makeTempDir({ prefix: 'sb-desktop-owner-' });
try {
  const args = [
    'gen',
    '--workspace',
    `${root}/hero`,
    '--character',
    'hero',
    '--model',
    'fixture-gen',
    '--image',
    fileURLToPath(new URL('../../tests/fixtures/bulma-front.png', import.meta.url)),
    '--json',
  ];
  const r = await c.call('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async()=>{
 const {makeBridge: actualBridge}=await import('/src/bridge.ts');
 const {log}=await import('/src/log.ts');
 const native=actualBridge();
 if(native.name!=='tauri')throw new Error('This proof requires the real Tauri shell');
 const args=${JSON.stringify(args)};
 const rosterRoot=${JSON.stringify(root)};
 const first=await native.runCli(args);
 if(first.exitCode!==0)throw new Error('Native fixture generation failed: '+first.lines.join('\\n'));
 const before=JSON.stringify((await native.listWorkspaces(rosterRoot))[0].manifest);
 const controller=new AbortController();
 const canceled=await native.runCli([...args,'--seed','1','--candidates','8'],line=>{
   const e=JSON.parse(line);
   if(e.t==='progress'&&e.step==='generate')controller.abort();
 },controller.signal);
 if(canceled.exitCode!==130)throw new Error('Native cancel did not terminate the job');
 if(JSON.stringify((await native.listWorkspaces(rosterRoot))[0].manifest)!==before)throw new Error('Canceled native job changed accepted results');
 const retry=await native.runCli([...args,'--seed','2']);
 if(retry.exitCode!==0)throw new Error('Native retry failed: '+retry.lines.join('\\n'));
 if((await native.listWorkspaces(rosterRoot))[0].manifest.generation.results.length!==2)throw new Error('Native retry did not append exactly one result');
 const failure=await native.runCli(['undo','--manifest','__missing_ownership_fixture__/character.json']);
 if(failure.exitCode===0)throw new Error('Missing workspace succeeded');
 const diagnostics=log.snapshot().lines.filter(l=>l.stream==='stderr');
 if(!diagnostics.length || diagnostics.some(d=>failure.lines.includes(d.line)))throw new Error('stderr missing or mixed into stdout');
 const resources=performance.getEntriesByType('resource').map(r=>r.name);
 const react=await import(resources.find(n=>n.includes('/deps/react.js')));
 const R=react.default??react;
 const dom=await import(resources.find(n=>n.includes('react-dom_client.js')));
 const {createRoot}=dom.default??dom;
 const {Editor}=await import('/src/editor.tsx');
 const {toCard}=await import('/src/manifest.ts');
 const {makeBridge}=await import('/src/bridge.ts');
 const requests=[];let changed=0;
 const bridge={...makeBridge(),readImage:async()=>null,readThumb:async()=>null,
 runCli:async(args,onLine,signal)=>{
 if(args[0]==='models')return {exitCode:0,lines:['{"models":[]}']};
 return new Promise(resolve=>requests.push({args,signal,resolve}));
 }};
 const {useJobBridge}=await import('/src/jobscope.ts');
 const probeHost=document.createElement('div');document.body.append(probeHost);const probeRoot=createRoot(probeHost);
 let scoped;
 function Probe({owner}){scoped=useJobBridge(bridge,owner).bridge;return null}
 probeRoot.render(R.createElement(Probe,{owner:'old'}));await new Promise(r=>setTimeout(r,60));
 const stale=scoped.runCli(['pick','--workspace','old']);
 probeRoot.render(R.createElement(Probe,{owner:'new'}));await new Promise(r=>setTimeout(r,60));
 requests[0].resolve({exitCode:0,lines:[]});
 if((await stale).exitCode!==130)throw new Error('A stale successful response escaped its canceled scope');
 probeRoot.unmount();probeHost.remove();requests.length=0;
 const host=document.createElement('div');document.body.append(host);
 const root=createRoot(host);
 const manifest=(id)=>({id,displayName:id,generation:{results:[{id:'r1',seed:1,params:{},output:{kind:'mesh',tris:1}}]}});
 let owner='a',m=manifest(owner);
 const render=()=>root.render(R.createElement(Editor,{key:owner,bridge,card:toCard(owner,m),manifest:m,onChanged:()=>changed++,onOpenModels:()=>{}}));
 const tick=()=>new Promise(r=>setTimeout(r,60));
 const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
 const pick=()=>{const b=[...host.querySelectorAll('button')].find(b=>b.textContent==='Save as canonical mesh');check(b,'missing pick action');b.click()};
 try{
 render();await tick();
 host.querySelector('.pickopts input').click();pick();await tick();check(requests.length===1,'pick did not start');
 owner='b';m=manifest(owner);render();await tick();
 check(requests[0].signal.aborted,'tab switch did not cancel');
 check(host.querySelector('.pickopts input').checked,'draft leaked to another character');
 const beforeOld=changed;requests[0].resolve({exitCode:0,lines:[]});await tick();check(changed===beforeOld+1,'interrupted scope did not request one fresh state read');
 pick();await tick();const cancel=[...host.querySelectorAll('button')].find(b=>b.textContent.includes('Cancel job'));
 check(cancel,'cancel action missing');cancel.click();check(requests[1].signal.aborted,'cancel did not reach bridge');
 requests[1].resolve({exitCode:0,lines:[]});await tick();check(changed>beforeOld,'cancellation did not request a recovered-state refresh');
 pick();await tick();m={...m,displayName:'changed externally'};render();await tick();
 check(requests[2].signal.aborted,'revision change did not cancel');const beforeRevisionReply=changed;requests[2].resolve({exitCode:0,lines:[]});await tick();check(changed===beforeRevisionReply+1,'interrupted revision did not request one fresh state read');
 pick();await tick();requests[3].resolve({exitCode:0,lines:[]});await tick();check(changed>beforeRevisionReply,'retry did not publish');
 return {nativeCancel:true,nativeRetry:true,tabSwitch:true,draftsIsolated:true,staleRevision:true,cancel:true,retry:true};
 }finally{root.unmount();host.remove()}
})()`,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  console.log(JSON.stringify(r, null, 2));
} finally {
  c.close();
  await Deno.remove(root, { recursive: true });
}
