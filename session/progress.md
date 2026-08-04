# Progress log

## 2026-08-02 — session start

Baseline green before any edit: `npm run typecheck` clean, `npm test` 408 pass /
0 fail. Read the goal, mapped the import graph, split the work into three
phases (see `session-state.md`).

Key finding from the map: `src/completionProvider.ts` is not purely FIM — it is
the `InlineCompletionItemProvider` that renders the insert-walk and diff-replay
ghosts. Deleting it outright would kill the hero path. It gets rewritten, not
removed.

## 2026-08-02 — phases 1 and 2 landed (commit 33fc5b3)

Both removals went in as one increment: they share `extension.ts` and
`package.json`, and splitting them would have left a half-wired manifest in
between.

Deleted: `ollama.ts`, `templates.ts`, `postprocess.ts`, `config.ts`,
`modelPull.ts`, `noteWeave.ts`, `completionProvider.ts`,
`disclosure/comments.ts`, `promptgen.ts`, `actionability.ts`,
`commentAnchor.ts`, and their four oracles.

Added: `src/ghostProvider.ts` — the replay-only inline-completion surface.

Manifest: 7 commands and 11 settings removed, the comment-thread menu
contribution removed. What remains is Start Replay, the step controls, the
Replay Guide view, the Tab keybindings, and three guide settings.

Prose reconciled in the same pass: `CLAUDE.md` invariants (model-free is now
unconditional), `src/.index.md`, `src/disclosure/.index.md`, `test/.index.md`,
`docs/.index.md`, the FIM section of `docs/pending-work.md`, and the one stale
README sentence.

Verified: `npm test` 378 pass / 0 fail, `npm run typecheck` clean,
`npm run build` clean, and `dist/extension.js` carries zero occurrences of
ollama / api/generate / FIM markers.

## 2026-08-02 — review, triage, phase close

Blind oracle returned 13 assertions over the manifest and file tree, all green,
and proved itself non-vacuous by failing 9 of 13 against the pre-removal tree.
Committed as `39c2bec`.

Adversarial review found no hero-path break, no dangling reference, no
over-removal, and no under-removal. It went as far as stubbing `vscode` and
running `activate()` against the shipped bundle: 15 commands registered, one
inline provider, retrospective diagnostics still wiring. Test-count arithmetic
checked out exactly (408 - 30 deleted = 378), so no incidental coverage was
lost in the deletions.

Three findings. Triage returned one Do:

- **Do (applied):** `.vscodeignore` had no `session/**` entry, so
  `npm run package` was shipping this session's working notes — including the
  raw goal — into the .vsix. One line. Verified: 113 files → 108, zero session
  entries.
- **Defer:** stale root `.index.md` (auto-generated, gitignored, self-heals on
  re-index) and a pre-existing `validate-guide.js` crash on a bad target root.
- **Delegate:** the release and its notes. Version stays 0.5.1.

Both defers and the delegate are written up in `scraps.md`.
