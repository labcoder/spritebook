// throwaway diagnostic: does BrowserWindow construction complete at all?
console.log('constructing…');
const win = new Deno.BrowserWindow({ title: 'diag', width: 400, height: 300 });
console.log('constructed OK');
win.navigate('http://localhost:5173');
console.log('navigate called');
setTimeout(() => {
  console.log('event loop alive 5s later');
  Deno.exit(0);
}, 5000);
