/**
 * A small CONTROLLED modal: backdrop click, Escape, focus-on-open, and a Tab
 * trap — all in component code, so behavior is verifiable (synthetic events
 * included) and focus semantics are ours. aria-modal + role=dialog.
 */
import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal(
  { open, onClose, label, className, children, initialFocus }: {
    open: boolean;
    onClose: () => void;
    label: string;
    className: string;
    children: React.ReactNode;
    /** CSS selector focused on open; falls back to the first focusable */
    initialFocus?: string;
  },
) {
  const popRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const pop = popRef.current;
    const target = (initialFocus ? pop?.querySelector<HTMLElement>(initialFocus) : null) ??
      pop?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => restoreRef.current?.focus?.();
  }, [open, initialFocus]);

  if (!open) return null;
  return (
    <div
      className='pal-backdrop'
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={popRef}
        role='dialog'
        aria-modal='true'
        aria-label={label}
        className={className}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Tab') {
            const items = [
              ...(popRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ??
                []),
            ]
              .filter((el) => !el.hasAttribute('disabled'));
            if (items.length === 0) return;
            const first = items[0]!;
            const last = items[items.length - 1]!;
            if (e.shiftKey && document.activeElement === first) {
              last.focus();
              e.preventDefault();
            } else if (!e.shiftKey && document.activeElement === last) {
              first.focus();
              e.preventDefault();
            }
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
