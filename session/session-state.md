# Session state — strip the extension back to guide-driven replay

## Goal (from goal.md)

Remove the Ollama/FIM autocomplete layer and the comments-to-prompt layer. What
remains: read the replay guide, Tab the code in. Model-free, deterministic.

## Scope call (recorded, not asked)

The retrospective layer (`src/retrospective/`, guide `Retrospective`/`Invariant`
blocks, the weak-question smell) **stays**. It is model-free guide content
surfaced as diagnostics, not a generated prompt and not an inline note the human
authors. Removing it would change the canonical guide format, which the goal
does not ask for. Flagged in the handoff.

The inline-completion provider **stays but shrinks**: it is the surface the
insert walk and diff-replay ghosts render through. Only its FIM branch goes.

## Phases

- [x] **Phase 1 — FIM/Ollama removal.** Delete `ollama.ts`, `templates.ts`,
  `postprocess.ts`, `config.ts`, `modelPull.ts`, `noteWeave.ts`. Rewrite
  `completionProvider.ts` as a replay-only ghost provider. Drop the
  `toggle` / `startOllama` / `chooseModel` / `reviveAutocomplete` commands and
  every model setting from `package.json`. Drop `test/pull-progress.test.cjs`,
  `test/note-weave.test.cjs`.
- [x] **Phase 2 — comments + promptgen removal.** Delete
  `disclosure/comments.ts`, `promptgen.ts`, `actionability.ts`,
  `commentAnchor.ts`. Drop the four `humanReplay.comments.*` commands, the
  comment-thread menu contribution, and the `onDidChangeTextDocument` reanchor
  call. Drop `test/actionability.test.cjs`, `test/comment-anchor.test.cjs`.
- [x] **Phase 3 — manifest + prose reconcile, verification sweep.** Manifest
  description/keywords/categories, `CLAUDE.md` invariants, the stale README and
  `docs/pending-work.md` claims. Full green: `npm test`, `npm run typecheck`,
  `npm run build`, `scripts/validate-guide.js` on the shipped guide.

## Oracle

New black-box oracle `test/surface.test.cjs`: parses `package.json` + the built
bundle and asserts the removed surface is gone (no model settings, no comment
commands, no `ollama` in the bundle) while the replay surface is intact. Written
blind against the goal, before Phase 1 implementation.

## Status

Done. All three phases landed, one review-and-triage pass run, its single Do
item applied.

Green: 391 tests pass (378 surviving + 13 from the blind oracle), typecheck
clean, build clean. Bundle 104,431 → 84,645 bytes. The .vsix no longer carries
`session/`.

Unverifiable by any oracle: whether the extension actually activates and draws
ghosts in a real host. See `visual-residual.md` — that F5 walk is the remaining
gate.
