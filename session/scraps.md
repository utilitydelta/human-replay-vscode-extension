# Scraps — for the human after the session

Triage output on the adversarial review. One Do item was found and applied
(`session/**` added to `.vscodeignore`); everything below is what triage
declined to act on, and why.

## Delegate — your call, not an agent's

**The release, and what its notes should say.** `CHANGELOG.md` has no 0.5.1
section at all (that gap predates this session), and nothing for this removal.
Two things worth a line when you cut the next version:

- Eleven `humanReplay.*` settings and six commands left the manifest. Anyone who
  ever ran Toggle Autocomplete has `"humanReplay.enabled": true` sitting in
  their global `settings.json`, and VS Code will now flag it as an unknown
  setting. Nothing breaks. But nothing tells them why either.
- `description` and `categories` in `package.json` changed, and both are
  Marketplace-visible. The description no longer claims a local FIM
  autocomplete; `Machine Learning` is gone from categories.

Version is still 0.5.1 — no bump was made, since releasing is yours to call.

## Defer — real, but not now

**Stale root `.index.md`.** The per-folder context docs were updated in the
removal commit, but the repo-root summary still describes `completionProvider`,
`ollama`, `templates`, `postprocess`, `modelPull`, and `noteWeave` as the
architecture. It is auto-generated and gitignored, so this is a re-index, not an
edit — hand-editing a generated file to paper over drift is the wrong move.
Trigger: the next indexer run, or the first time an agent answers a question
about this extension and mentions FIM.

**`scripts/validate-guide.js` crashes on a bad target root.** Passing a target
directory that has none of the guide's files throws
`TypeError: Cannot read properties of undefined (reading 'indexOf')` at
`spliceBytes` (line 120) instead of reporting a missing-target failure. The
crash also strands `scripts/.validate.entry.ts` untracked, because `.gitignore`
covers only `**/*.bundle.cjs`. Both reproduce identically at `b0eb7ec`, so
neither came from this change, and this commit never touches `scripts/`.
Trigger: next time anyone opens that file — then fix both together.

## Leftover Do items

None. Triage returned one Do; it was applied and verified (the .vsix went from
113 files to 108, with zero `session/` entries).
