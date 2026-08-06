/**
 * Focus continuity - the two helpers every stage surface shares.
 *
 * The full-journey keyboard walkthrough (tools/proofs/walkthrough_journey.ts)
 * found one systemic break repeated on every surface: an async action's
 * button sets `disabled={busy}` and the browser drops focus of a disabled
 * element to <body>; when the run finishes, the button has often unmounted
 * (success swaps the panel) and nothing restores focus. A keyboard user is
 * dumped to the top of the document after EVERY operation - generate, pick,
 * rig, accept, enable, record, bake, export. Per-surface audits never saw it
 * because it only bites when an action COMPLETES and the journey continues.
 *
 * `useLandFocus` is the repair: when `when` flips false->true (the result
 * content just arrived), focus the element for `selector` on the next frame
 * (after React commits). Non-interactive landing targets get tabIndex=-1 so
 * they accept programmatic focus without joining the tab order.
 *
 * `useRovingRadio` is the other repeated finding: role=radiogroup with
 * role=radio buttons that are each their own tab stop and ignore arrow keys.
 * The role PROMISES the radio contract - arrows move+select, one tab stop
 * per group - and screen readers tell users so. This hook supplies it, the
 * same roving-tabindex model the character tabs already implement.
 */
import { useEffect, useRef } from 'react';

/** Focus `selector` when `when` flips false->true. */
export function useLandFocus(when: boolean, selector: string): void {
  const was = useRef(when);
  useEffect(() => {
    const rising = when && !was.current;
    was.current = when;
    if (!rising) return;
    // next frame: the content for `selector` commits in this same render
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return;
      if (!el.matches('a[href],button,input,select,textarea,[tabindex]')) el.tabIndex = -1;
      el.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [when, selector]);
}

export interface RovingRadioItem {
  ref: (el: HTMLElement | null) => void;
  tabIndex: number;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

/**
 * The WAI-ARIA radio-group keyboard contract over a list of buttons:
 * one tab stop (the selected item, or the first when none is), arrows move
 * selection AND focus, wrapping at the ends.
 */
export function useRovingRadio(
  count: number,
  selected: number,
  onSelect: (i: number) => void,
): (i: number) => RovingRadioItem {
  const refs = useRef<(HTMLElement | null)[]>([]);
  refs.current.length = count;
  return (i: number) => ({
    ref: (el: HTMLElement | null) => {
      refs.current[i] = el;
    },
    tabIndex: i === (selected >= 0 ? selected : 0) ? 0 : -1,
    onKeyDown: (e: React.KeyboardEvent) => {
      let next: number | null = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % count;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + count) % count;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = count - 1;
      if (next === null) return;
      e.preventDefault();
      onSelect(next);
      refs.current[next]?.focus();
    },
  });
}
