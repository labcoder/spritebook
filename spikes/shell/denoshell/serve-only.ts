// Isolation test A: no BrowserWindow at all. Per docs, the bootstrap webview
// auto-navigates to the Deno.serve address. HTTP hits in out/serve-hits.log
// prove the webview process boots; their absence points at the bootstrap layer.
Deno.serve((req) => {
  Deno.writeTextFileSync(
    `${Deno.cwd()}/out/serve-hits.log`,
    `${new Date().toISOString()} ${req.method} ${req.url} UA=${req.headers.get('user-agent')?.slice(0, 60)}\n`,
    { append: true },
  );
  return new Response(
    '<!doctype html><title>serve-only</title><h1>serve-only OK</h1>',
    { headers: { 'content-type': 'text/html' } },
  );
});
