# Agent setup

- **Canonical instructions:** `/AGENTS.md` (uppercase, repo root). `CLAUDE.md` is a pointer to it —
  never fork the two.
- **Skills:** `.agents/skills/<name>/SKILL.md`.
- **Docs layout:** `docs/` is tracked product truth (PRD, architecture, design system,
  dependencies). `docs/internal/` is gitignored planning space (roadmap, decisions, progress) —
  local-only by design (D-015). Keep both in sync with reality: if code changes make a doc wrong,
  fixing the doc is part of the change.
- **Scoped AGENTS.md files** exist in `docs/developer/architecture/` and `docs/developer/design/`
  with domain-specific guidance; they supplement, never override, the root file.
