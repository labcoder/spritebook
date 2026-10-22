/**
 * Lingui runtime, wired from the first string (hard commitment 3). No build
 * macro yet: `t(id)` calls `i18n._(id)` with the LITERAL English string as
 * the message id — exactly the callsite shape `lingui extract` consumes when
 * the extraction pass lands, so nothing here is throwaway. `en` is the
 * identity catalog (id === message); `pseudo` answers through the missing-
 * message handler with a +40% accented expansion, which is the live proof
 * that layouts survive growth.
 */
import { setupI18n as makeI18n } from '@lingui/core';
import { pseudoExpand } from './pseudo';
import { es } from './locales/es';

export type Locale = 'en' | 'es' | 'pseudo';

export const i18n = makeI18n({
  messages: { en: {}, es, pseudo: {} },
  // en is the identity catalog (id IS the copy); the pseudo catalog is a
  // FUNCTION, not data — any id it is asked for comes back +40% expanded, so
  // no string can dodge the growth proof by being new. es falling through
  // here means a missing translation, and the extractor gate fails CI first.
  missing: (
    locale: string,
    id: string,
  ) => (locale === 'pseudo' ? pseudoExpand(id) : id),
});

export function setupI18n(initial: Locale): void {
  i18n.activate(initial);
}

export function activateLocale(locale: Locale): void {
  i18n.activate(locale);
}

/** Translate. The id IS the English copy — extraction-ready callsites. */
export function t(id: string): string {
  return i18n._(id);
}
