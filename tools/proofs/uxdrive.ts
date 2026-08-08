/**
 * UX-pass driver: one-shot CDP actions against the running desktop app, so a
 * reviewer (human or agent) can drive the REAL app step by step and screenshot
 * what a user actually sees. Trusted input only - mouse via
 * Input.dispatchMouseEvent, keys via the walkthrough's own press/typeText.
 *
 *   deno run --allow-net=127.0.0.1 --allow-write --allow-env tools/proofs/uxdrive.ts <cmd> [...]
 *
 *   shot <name>          screenshot -> docs/internal/proofs/uxpass2/<name>.png
 *   click <selector>     trusted left click at the element's center
 *   clicktext <text>     click the first button/link whose text includes <text>
 *   type <text>          Input.insertText into the focused element
 *   key <Key>            press one navigation key (Enter, Tab, ...)
 *   eval <expr>          Runtime.evaluate, prints JSON
 *   waitfor <expr> [ms]  poll until truthy (default 30000)
 */
import { Cdp, evalJs, press, typeText } from './walkthrough.ts';

const PORT = Number(Deno.env.get('SPRITEBOOK_CDP_PORT') ?? '9223');
const OUT = new URL('../../docs/internal/proofs/uxpass2/', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');

async function center(cdp: Cdp, selector: string): Promise<{ x: number; y: number }> {
  const box = await evalJs<{ x: number; y: number; w: number; h: number } | null>(
    cdp,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null; el.scrollIntoView({block:'center'});
       const r = el.getBoundingClientRect();
       return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height }; })()`,
  );
  if (!box) throw new Error(`no element for ${selector}`);
  return { x: Math.round(box.x), y: Math.round(box.y) };
}

async function clickAt(cdp: Cdp, x: number, y: number): Promise<void> {
  const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
  await cdp.call('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await cdp.call('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

const [cmd, ...rest] = Deno.args;
const cdp = await Cdp.connect(PORT);
try {
  switch (cmd) {
    case 'shot': {
      const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' }) as {
        data: string;
      };
      await Deno.mkdir(OUT, { recursive: true });
      const path = `${OUT}${rest[0] ?? 'shot'}.png`;
      await Deno.writeFile(path, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      console.log(path);
      break;
    }
    case 'click': {
      const { x, y } = await center(cdp, rest[0]!);
      await clickAt(cdp, x, y);
      console.log(`clicked ${rest[0]} @ ${x},${y}`);
      break;
    }
    case 'clicktext': {
      const box = await evalJs<{ x: number; y: number } | null>(
        cdp,
        `(() => { const t = ${JSON.stringify(rest.join(' '))};
           const el = [...document.querySelectorAll('button, a, [role=tab]')]
             .find(e => e.textContent && e.textContent.includes(t));
           if (!el) return null; el.scrollIntoView({block:'center'});
           const r = el.getBoundingClientRect();
           return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`,
      );
      if (!box) throw new Error(`no clickable with text "${rest.join(' ')}"`);
      await clickAt(cdp, box.x, box.y);
      console.log(`clicked "${rest.join(' ')}" @ ${box.x},${box.y}`);
      break;
    }
    case 'clicknth': {
      const [text, nth] = [rest.slice(0, -1).join(' '), Number(rest.at(-1))];
      const box = await evalJs<{ x: number; y: number } | null>(
        cdp,
        `(() => { const els = [...document.querySelectorAll('button, a, [role=tab]')]
             .filter(e => e.textContent && e.textContent.includes(${JSON.stringify(text)}));
           const el = els[${nth}]; if (!el) return null; el.scrollIntoView({block:'center'});
           const r = el.getBoundingClientRect();
           return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`,
      );
      if (!box) throw new Error(`no clickable #${nth} with text "${text}"`);
      await clickAt(cdp, box.x, box.y);
      console.log(`clicked "${text}"[${nth}] @ ${box.x},${box.y}`);
      break;
    }
    case 'type':
      await typeText(cdp, rest.join(' '));
      console.log('typed');
      break;
    case 'key':
      await press(cdp, rest[0]!);
      console.log(`pressed ${rest[0]}`);
      break;
    case 'eval':
      console.log(JSON.stringify(await evalJs(cdp, rest.join(' '))));
      break;
    case 'waitfor': {
      const [expr, msArg] = [rest[0]!, rest[1]];
      const deadline = Date.now() + (msArg ? Number(msArg) : 30_000);
      while (Date.now() < deadline) {
        if (await evalJs<boolean>(cdp, `Boolean(${expr})`)) {
          console.log('ready');
          Deno.exit(0);
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      console.error(`timeout waiting for ${expr}`);
      Deno.exit(1);
      break;
    }
    default:
      console.error('unknown cmd');
      Deno.exit(2);
  }
} finally {
  cdp.close();
}
