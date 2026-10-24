# Localization

Studio uses Lingui with literal English messages as identifiers. The runtime lives in
[`apps/studio/src/i18n.ts`](../../apps/studio/src/i18n.ts); the Spanish catalog lives in
[`src/locales/es.ts`](../../apps/studio/src/locales/es.ts). English falls back to the identifier.
The pseudo locale expands and accents text to expose cramped layouts.

## Add or change UI text

1. Wrap user-facing text in a literal call such as `t('Delete project')`. Keep the whole message
   visible to the extractor; `t(variable)` and template-string calls are rejected.
2. Add or update the matching Spanish entry in `src/locales/es.ts`.
3. Run the extractor from the repository root:

   ```sh
   npm run i18n:extract -w spritebook-studio
   ```

4. Check the relevant screens in English, Spanish and pseudo. Use **Edit → Language**; check the
   960×600 minimum window, long paths, narrow inspectors, dialogs and keyboard focus.

The extractor reports nonliteral calls and missing Spanish entries as errors. It reports unused
entries for cleanup. The normal test suite runs the same checks. Extraction does not translate text
or create `.po` files; this repository keeps its current catalog in TypeScript.

Use sentence case and outcome verbs. Leave CLI flags, model IDs, paths and log output unchanged;
translate their surrounding explanation. Prefer a complete message over joining translated fragments
whose word order changes between languages. Keep model/backend failure details verbatim in the
session log, with a translated recovery action beside them.

## Add a locale

Add its catalog under `src/locales/`, register it with the Lingui runtime and `Locale` type, and add
it to the title-bar menu's language choices. Add a catalog-coverage check equivalent to the Spanish
one before advertising the locale. Test expanded copy and fallback behavior alongside the
[design system](design/design-system.md); a translated catalog alone does not prove layout or
keyboard usability.
