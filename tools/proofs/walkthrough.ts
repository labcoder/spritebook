/**
 * The full-journey keyboard-only walkthrough (P4-T1's last acceptance item).
 *
 * Drives the REAL desktop app — the Tauri shell with the real CLI bridge —
 * over the WebView2 remote-debugging protocol. Every input is a TRUSTED key
 * event through the browser's own input pipeline (`Input.dispatchKeyEvent`),
 * which is what a keyboard produces; nothing here synthesizes DOM events or
 * clicks. After every key the focused element is read back, so the output is
 * a complete focus trace: where Tab went, in order, across the whole journey.
 *
 * Why CDP and not a screenshot driver: the auditable fact is WHICH element
 * has focus, and a screenshot cannot answer that reliably (focus rings crop,
 * scroll, or style away). `document.activeElement` is the ground truth the
 * WCAG keyboard criterion is about.
 *
 * Run: launch the app with the debug port, then the driver —
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 deno task dev:desktop
 *   deno run --allow-net=127.0.0.1 --allow-write tools/proofs/walkthrough.ts
 */

// ---------------------------------------------------------------- CDP client

interface CdpMsg {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

export class Cdp {
  #ws!: WebSocket;
  #id = 0;
  #pending = new Map<number, (m: CdpMsg) => void>();

  static async connect(port: number): Promise<Cdp> {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t: { type: string }) => t.type === 'page');
    if (!page) throw new Error('no page target - is the app running with the debug port?');
    const cdp = new Cdp();
    await new Promise<void>((resolve, reject) => {
      cdp.#ws = new WebSocket(page.webSocketDebuggerUrl);
      cdp.#ws.onopen = () => resolve();
      cdp.#ws.onerror = (e) => reject(e);
      cdp.#ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as CdpMsg;
        if (m.id !== undefined) {
          cdp.#pending.get(m.id)?.(m);
          cdp.#pending.delete(m.id);
        }
      };
    });
    return cdp;
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(
        id,
        (m) =>
          m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result ?? {}),
      );
    });
  }

  close() {
    this.#ws.close();
  }
}

// ------------------------------------------------------------------ keyboard

/** Windows virtual key codes for the navigation keys the walkthrough uses. */
const VKEY: Record<string, number> = {
  Tab: 9,
  Enter: 13,
  Escape: 27,
  Space: 32,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Backspace: 8,
};
const KEYTEXT: Record<string, string> = { Enter: '\r', Space: ' ', Tab: '\t' };

export interface Modifiers {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

/** modifiers bitmask per CDP: Alt=1, Ctrl=2, Meta=4, Shift=8 */
const maskOf = (m: Modifiers) => (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.shift ? 8 : 0);

export async function press(cdp: Cdp, key: string, mods: Modifiers = {}): Promise<void> {
  const vk = VKEY[key];
  if (vk === undefined) throw new Error(`no vkey for ${key}`);
  const modifiers = maskOf(mods);
  const base = { key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  // A full 'keyDown' (not 'rawKeyDown'), with text for the keys that carry it:
  // native activation - Enter clicking a focused button, Space toggling a
  // checkbox - only happens on the text-processing path, exactly as puppeteer
  // sends it. Tab moves focus either way, but activation is the point here.
  await cdp.call('Input.dispatchKeyEvent', {
    ...base,
    type: 'keyDown',
    ...(KEYTEXT[key] && !mods.ctrl && !mods.alt ? { text: KEYTEXT[key] } : {}),
  });
  await cdp.call('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

/**
 * Type a string into the focused element via `Input.insertText` - the same
 * pipeline an IME or paste uses, firing real `beforeinput`/`input` events at
 * the caret. Deliberately NOT per-character key events: mapping characters to
 * Windows virtual-key codes is layout-dependent and a wrong code is silent
 * ('.'.charCodeAt(0) is 46, which is VK_DELETE - the first draft of this
 * function typed 'bulma-frontpng' and the audit chased a phantom break for a
 * run). What this walkthrough audits is FOCUS TRAVERSAL, and that stays on
 * real key events; content entry only has to be faithful to the focused
 * element.
 */
export async function typeText(cdp: Cdp, text: string): Promise<void> {
  await cdp.call('Input.insertText', { text });
}

// ----------------------------------------------------------------- observers

export async function evalJs<T>(cdp: Cdp, expr: string): Promise<T> {
  const r = await cdp.call('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  const res = r.result as { value?: T; description?: string; subtype?: string };
  if ((r as { exceptionDetails?: unknown }).exceptionDetails) {
    throw new Error(
      `evalJs threw: ${
        JSON.stringify((r as { exceptionDetails?: unknown }).exceptionDetails).slice(0, 300)
      }`,
    );
  }
  return res.value as T;
}

export interface FocusInfo {
  tag: string;
  id: string;
  cls: string;
  label: string;
  role: string;
  text: string;
  disabled: boolean;
}

/** The ground truth after every key: what actually has focus. */
export function active(cdp: Cdp): Promise<FocusInfo> {
  return evalJs<FocusInfo>(
    cdp,
    `(() => { const e = document.activeElement || document.body;
      return {
        tag: e.tagName.toLowerCase(),
        id: e.id || '',
        cls: (typeof e.className === 'string' ? e.className : '').split(' ').slice(0,3).join(' '),
        label: e.getAttribute('aria-label') || '',
        role: e.getAttribute('role') || '',
        text: (e.textContent || '').trim().slice(0, 40),
        disabled: !!e.disabled,
      }; })()`,
  );
}

export async function waitFor(
  cdp: Cdp,
  expr: string,
  what: string,
  timeoutMs = 120_000,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await evalJs<boolean>(cdp, `!!(${expr})`)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Tab until focus lands on a matching element; every hop is logged. A bound
 * on hops is the unreachability detector: running out IS the finding. */
export async function tabTo(
  cdp: Cdp,
  match: (f: FocusInfo) => boolean,
  what: string,
  log: (s: string) => void,
  maxHops = 60,
  mods: Modifiers = {},
): Promise<FocusInfo> {
  for (let i = 0; i < maxHops; i++) {
    const f = await active(cdp);
    if (match(f)) {
      log(`  -> ${what}: ${fmt(f)} (${i} hops)`);
      return f;
    }
    await press(cdp, 'Tab', mods);
  }
  const f = await active(cdp);
  throw new Error(
    `UNREACHABLE by keyboard: ${what} - after ${maxHops} Tab hops, focus is at ${fmt(f)}`,
  );
}

export const fmt = (f: FocusInfo) =>
  `<${f.tag}${f.id ? '#' + f.id : ''}${f.cls ? '.' + f.cls.split(' ')[0] : ''}>` +
  `${f.label ? ` "${f.label}"` : f.text ? ` "${f.text}"` : ''}${f.disabled ? ' DISABLED' : ''}`;
