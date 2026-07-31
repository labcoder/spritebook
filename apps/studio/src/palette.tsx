/**
 * The ⌘K command palette — implemented, not a dead chip (the design doc's
 * own ultimatum). It lists ONLY actions that exist elsewhere in the chrome:
 * fuzzy filter, arrow keys, Enter runs. Base UI Dialog supplies the focus
 * trap and escape semantics.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './modal';
import { t } from './i18n';

export interface PaletteAction {
  id: string;
  title: string;
  /** shown right-aligned: a shortcut or a scope hint */
  hint?: string;
  enabled: boolean;
  run: () => void;
}

/** Subsequence fuzzy score: consecutive and word-start hits rank higher; -1 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  if (q.length === 0) return 0;
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) {
      streak++;
      score += streak + (si === 0 || s[si - 1] === ' ' ? 3 : 0);
      qi++;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

export function Palette({ open, onClose, actions }: {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    return actions
      .filter((a) => a.enabled)
      .map((a) => ({ a, score: fuzzyScore(query, a.title) }))
      .filter((m) => m.score >= 0)
      .sort((x, y) => y.score - x.score)
      .map((m) => m.a);
  }, [actions, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setAt(0);
    }
  }, [open]);
  useEffect(() => setAt(0), [query]);

  const run = (a: PaletteAction) => {
    onClose();
    a.run();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      label={t('Command palette')}
      className='pal'
      initialFocus='.pal-input'
    >
      <input
        ref={inputRef}
        className='pal-input mono'
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('Type a command…')}
        aria-label={t('Command palette')}
        role='combobox'
        aria-expanded='true'
        aria-controls='pal-list'
        aria-activedescendant={matches[at] ? `pal-${matches[at].id}` : undefined}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            setAt((v) => Math.min(v + 1, matches.length - 1));
            e.preventDefault();
          } else if (e.key === 'ArrowUp') {
            setAt((v) => Math.max(v - 1, 0));
            e.preventDefault();
          } else if (e.key === 'Enter' && matches[at]) {
            run(matches[at]);
            e.preventDefault();
          }
        }}
      />
      <div
        id='pal-list'
        role='listbox'
        aria-label={t('Commands')}
        className='pal-list'
      >
        {matches.length === 0 && <div className='pal-empty'>{t('No matching command')}</div>}
        {matches.map((a, i) => (
          <div
            key={a.id}
            id={`pal-${a.id}`}
            role='option'
            aria-selected={i === at}
            className={`pal-item ${i === at ? 'on' : ''}`}
            onPointerMove={() => setAt(i)}
            onClick={() => run(a)}
          >
            <span>{a.title}</span>
            {a.hint && <span className='pal-hint mono'>{a.hint}</span>}
          </div>
        ))}
      </div>
    </Modal>
  );
}
