# Manual-testing feedback — 2026-07-03 session

Raw findings from replaying the demo guides (C# discounts session), and the
build-out decisions made from them. Each item tracks to a fix; tick them off
as the F5 checks pass.

## 1. Create-file steps land as one silent drop

**Observed:** Step 1.1 (create `DiscountEngine.cs`) wrote the whole file and
jumped straight to step 1.2. No time to read the code; disorienting.

**Two problems in one:**

- [x] **Whole file in a single gesture.** The engine has no file walk — a
  brand-new file has no anchor, so it drops whole. Decision: build the
  engine-level file walk. Disclose a new file top-level item by item (one Tab
  each, blank-line-separated groups land together), with the full descend-and-
  fill walk inside bare functions. That is the point of the extension; a file
  drop teaches nothing.
- [x] **Zero-gesture auto-advance.** `runCreateFile` completed itself and
  flowed into the next step. The file walk fixes the root cause (create-file
  now ends on a human Tab like every other step).

## 2. No pause at phase boundaries

**Observed:** Finishing a phase auto-runs the first step of the next phase.
At scale (3 phases × 6 steps × 10–20 Tabs) the human needs a breath: read the
invariants, sit with the retrospective, review what landed.

- [x] Decision: pause when the completed step's phase differs from the next
  step's phase. Announce "phase complete", advance only on an explicit gesture
  (status bar click, tree click, Run Next Step). Flow freely within a phase.

## 3. Back/forward navigation is broken during replay

**Observed:** The replay teleports across files but `Ctrl+Alt+-` has nothing
to rewind — programmatic `editor.selection =` writes no navigation history.

- [x] Decision: step-level jumps (open target, park cursor) go through
  `showTextDocument` with a selection so they land in nav history. Engine-
  internal repositions (hunk to hunk) stay out — twenty Tabs must not mean
  twenty history entries.

## 4. Mid-step manual editing fights the caret

**Observed:** Mid step 2.1, typed a new function into `Cart.cs`. On every
typing pause and every arrow key the extension yanked the caret back to the
walk frontier (the climb-out in `offerRecovery`). Only Esc freed it.

- [x] Decision: never move the caret on a timer or a selection event. A step
  run may open the file, park the cursor, reveal the viewport — that is a
  human gesture. Mid-step divergence leaves the caret alone.
- [x] Returning the caret to the insertion point (detected via AST container
  match) re-shows the ghost where the human is.
- [x] If they forget where the walk was: clicking the step in the Replay
  Guide tree re-arms it — moves the caret, shows the ghost.
- [x] Tab only acts as "continue the walk" when the caret is in the walk's
  container; elsewhere Tab stays an indent (context key gates the keybinding).

## 5. Swallowed trigger turned Tab into typed bytes (retest finding)

**Observed:** Segment 2 armed with no ghost. Tab fell through to the editor and
typed a 4-space indent at the anchor; the settle re-anchor then showed the
ghost after those bytes and the class landed behind them — file differed from
the sandbox on line 3, step still marked done. Ground truth violated.

- [x] Ghost-less Tab on an armed diff-replay step nudges the ghost (on the
  armed line) or stays a plain indent (everywhere else). Tab can never type
  bytes into the replay by accident.
- [x] File-walk completion verifies the buffer against the sandbox concat;
  a mismatch blocks the step instead of lying green. Re-running a blocked
  create-file lands the delta as Tab-gated patch hunks.
- [x] The armed-ghost gap in the logs is closed (`[diff-replay] … armed`).

## 6. Whole class in one Tab (retest finding)

**Observed:** The comment+class segment landed as a single block ghost. Wanted
AST-level Tabs.

- [x] Container walk: classes, impls, and mods are descendable — shell first,
  members one by one, methods descending like functions. Walk layout is now
  source-derived (blank lines between members survive), and the segment's
  trailing newline is typed so last segments actually walk. Verified across
  C#, TS/TSX, Rust; Python/Markdown/HTML/CSS stay block-per-segment by design
  (no create walk).

## F5 checks (feel gates — the human signs these off)

- [ ] Create-file discloses item by item; comment blocks read before Tab
- [ ] C# class walks: shell, consts, method shell, statements — not one blob
- [ ] Ghost-less Tab nudges; Tab in your own code still indents
- [ ] Phase boundary pauses; explicit continue works from status bar and tree
- [ ] Back/forward rewinds across step jumps
- [ ] Manual mid-step editing never loses the caret; ghost returns on re-entry
- [ ] Tree click re-arms an in-flight step
