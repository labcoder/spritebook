/** F1-T3: real Editor mount in the desktop WebView; delayed jobs prove stale-completion guards.
 * Launch the dev shell with WebView2 CDP, then:
 * deno run --allow-net=127.0.0.1 tools/proofs/editor-ownership.ts 9224
 * Native descendant death is covered by cargo test; this proof injects delayed bridge responses.
 */
import { Cdp } from './walkthrough.ts';
const c = await Cdp.connect(Number(Deno.args[0] ?? 9224));
try {
  const r = await c.call('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async()=>{
 const {makeBridge: actualBridge}=await import('/src/bridge.ts');
 const {log}=await import('/src/log.ts');
 const native=actualBridge();
 if(native.name!=='tauri')throw new Error('This proof requires the real Tauri shell');
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
 requests[0].resolve({exitCode:0,lines:[]});await tick();check(changed===0,'stale character completion published');
 pick();await tick();const cancel=[...host.querySelectorAll('button')].find(b=>b.textContent.includes('Cancel job'));
 check(cancel,'cancel action missing');cancel.click();check(requests[1].signal.aborted,'cancel did not reach bridge');
 requests[1].resolve({exitCode:0,lines:[]});await tick();check(changed===0,'canceled completion published');
 pick();await tick();m={...m,displayName:'changed externally'};render();await tick();
 check(requests[2].signal.aborted,'revision change did not cancel');requests[2].resolve({exitCode:0,lines:[]});await tick();check(changed===0,'stale revision published');
 pick();await tick();requests[3].resolve({exitCode:0,lines:[]});await tick();check(changed===1,'retry did not publish');
 return {tabSwitch:true,draftsIsolated:true,staleRevision:true,cancel:true,retry:true};
 }finally{root.unmount();host.remove()}
})()`,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  console.log(JSON.stringify(r, null, 2));
} finally {
  c.close();
}
