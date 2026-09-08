# Changelog

## 2.1.0

Eight defects, and the suite found none of them. `scripts/harvest-replay.js`
harvests every changed symbol out of a repo's git history, pairs it
before/after, and pushes it through the real engine on the controller's exact
loop. It found 38 failures in the first 794 real symbol pairs it ran. The
oracles were green the whole time, because every corpus in them was written by
someone who already knew how the engine worked.

All eight are fixed. The same harness now runs 4,477 modify pairs and 2,631
creates out of nine repositories with zero failures, and the headless suite went
from 524 tests to 1,836.

- **A symbol never carries its own first-line indent.** Extraction started at the
  line start when an item had a doc comment above it and at the first visible
  byte when it did not, so the same function extracted two different ways
  depending on whether it was documented. Every comparison downstream — the
  diff, the insert proof's left context, resume's landed check — read a phantom
  indent change on top of the real one. The indent is layout of the container,
  not bytes of the symbol.
- **A created symbol's column is copied from the target, never counted.** The
  scaffold used to measure the anchor sibling's column and re-spell it with
  spaces, so a create into a tab-indented file landed a byte that exists in
  neither the sandbox nor the target. Nothing downstream could see it: extraction
  excludes the first line's indent, so the landed symbol still compared equal and
  resume called the step done.
- **An append at the end of a symbol lands.** The proof ratified a blank right
  context by position (`p === symText.length`), and a symbol whose bytes end in a
  newline puts the point one byte short of that. Every markdown section and every
  function whose extraction keeps its trailing line was refused. It is tail
  equality now, which still pins the point exactly.
- **A blank line under an insert is layout, not an absent tail.** The right
  context stopped at the next line, so an insert above a blank line baked a blank
  side that could only ratify positionally, and then collided. It keeps taking
  whole lines while the context is still whitespace, to a fail-loud cap of 64.
- **A guide saved with CRLF parses.** JS `.` never matches `\r`, so a guide
  checked out on Windows matched no heading, no field and no fence. It did not
  parse at all.
- **A fence closes on a run at least as long as the one that opened it.** A step
  whose After is itself a markdown file ended at the ``` inside its own bytes and
  replayed a truncated section. `splitSections` is fence-aware too, which was the
  bigger half: a `#` heading inside a fence tore the step apart before
  `parseFields` ever saw it. An unclosed fence throws rather than swallowing
  every step below it.
- **A symbol name that answers for more than one item says so.** Two `run`
  methods in different impls, a C# overload pair, a `### Fixed` heading per
  release: `findItemByName` takes the first in document order, which is a coin
  flip between real candidates, and the wrong pick is invisible in the buffer
  afterwards. The runner warns before it replays and the validator warns at
  authoring time. Neither picks for you.
- **The tree diff stopped allocating a substring per DP cell.** The LCS that
  anchors two symbol trees sliced each node's text inside the loop, m*n times. A
  2000-statement symbol took 2.1 seconds to diff a one-line change, which the
  human meets as the editor freezing when the step opens. Sliced once, the same
  symbol diffs in tens of milliseconds.

The new oracles are named for what they prove rather than what they call:
`replay-matrix` crosses eight language specs with seven byte shapes and nine
edit shapes, `divergence-matrix` types into the buffer mid-symbol and demands
either the merge or a collision, `blind-insert-contract` was written from the
contract without reading the implementation, and `field-defects` replays the
recorded bytes of each incident above.

## 2.0.0

Nothing slowed Tab down. A phase ran at keyboard-repeat speed and the
retrospective, the one place the guide asks you to think, arrived as an
Information squiggle you could ignore. On a create-file step it painted the
whole file blue.

Breaking, both repos: a step's retrospective now carries an answer key. The
generator writes `> **Answer:**` plus exactly two `> **Distractor:**` lines,
and one distractor or three is a parse error naming the step. Guides written
before this still load and still replay; their steps just do not gate.

- The retrospective is a gate. Three one-line choices stand between a finished
  step and the next one, shuffled per step, with the code and the guide one
  button away. A wrong pick is marked, shows the step's Why underneath, and
  locks the picker for `humanReplay.gateLockoutSeconds` (default 5). The gate
  is a forced pause with feedback, not a proof of understanding: elimination
  gets through, and that is fine.
- The squiggle is gone whole. No diagnostic, no Problems entry, no phase-
  boundary clear. The question, the Why and the invariants live in the Replay
  Guide tree now, under a step that expands. Until this release the Why, the
  one thing the guide writes for you rather than the engine, had no surface at
  all outside a tooltip.
- A weak question never gates. The smell was always a confidence probe on the
  agent that wrote the guide, and one that could not say why the code exists
  does not get to write its answer key. The validator fails the guide and
  reports `gated / wired / ungated / weak / over-length` so the author sees the
  gap before you do.
- The replay holds on what it just landed. `humanReplay.dwellSeconds` (default
  3) keeps the editor still long enough to read the bytes before the jump, with
  the landed range highlighted and a countdown on the end of it. Tab moves on
  now, Esc stays as long as you like. It never holds when the next step is
  already on screen, and never after a gate, which already stopped you with the
  code in view.
- Ground truth outranks the gate. Undo a step's bytes while its question stands
  and the gate drops, the step goes back to pending, and running it replays.
  Naming a different step in the tree outranks it too: that is navigation, and
  the human decides where to go.
- Tab is faster. Four paths awaited `inlineSuggest.trigger`, a command that
  resolves only once VS Code has polled every inline-completion provider in the
  window; the accept latches drop Tabs while a handler is in flight, so that
  wait was a swallowed keystroke on every step. Measured at 1703ms on a handler
  whose own ghost was ready in 82ms. Nothing after those awaits read a result.
- Every line in the output channel carries a wall clock, and the Tab paths
  report their own cost when it is slow enough to feel. Two stopwatches in this
  hunt measured think time and called it latency; a timestamp cannot.


## 1.2.0

Two live incidents drove this release. A foreign ghost Tab-accepted at an armed
step landed two later inserts 175 bytes off, silently. And a file-walk segment
froze the whole extension host: no ghost, dead Tab, dead save.

- Pure inserts are proven, not guessed. Every change the session sees — its own
  accepts and foreign edits alike — books into a ledger, and each insert bakes
  context from both sides at build time. A point lands only where both sides
  ratify; anything else collides loud and the log names the failed leg. The
  incident's exact bytes ship as a test corpus and replay green.
- Foreign bytes landing at the armed point pause the replay with a warning
  instead of silently re-anchoring around them. Keep them or undo, then re-run
  the step.
- A rewrite cancelled at zero steps restores the struck symbol, byte-checked.
  No more hole where the old code was. A partly landed walk keeps your work and
  restores nothing.
- Rewriting a nested doc-commented symbol reconciles the line indent before the
  walk starts, so the first ghost is Tab-acceptable instead of dead-ending on
  an indent.
- Fixed the freeze: a file-walk block segment (imports, a comment block) bakes
  a blank insert proof, and the collision forensics spun forever on it. The
  loop is guarded and resolves are latched out while a pending insert is mid-
  arm.

## 1.1.0

A spawned task body used to arrive as one ghost. `tasks.push(tokio::spawn(async move { ... }))`
revealed whole, so a 117-line body was a single Tab and no disclosure at all. Rust
blocks that close a call's argument list now descend.

- The block that closes a call's arguments discloses statement by statement. That
  covers the spawned task body and the trailing closure (`xs.iter().for_each(|x| { ... })`).
  Bytes after its close brace, the `));`, ride the shell, so nothing is stranded.
  Only a trailing block qualifies: a closure with real arguments after it still
  reveals whole, and mid-chain closures are unchanged.
- The output channel says whether VS Code queried the provider at all, and whether
  the step served or declined. "Armed, no ghost, dead Tab" used to look identical to
  "never queried", because serving is not drawing. One line per step, deduped so the
  per-keystroke auto-queries don't drown the channel.

## 1.0.0

The extension does one job now: read the replay guide, Tab the code in. The local
autocomplete moved to its own extension and the replay-notes layer went with it.
Nothing left here calls a model, on any path.

- Local FIM autocomplete is gone: the Ollama client, the prompt templates, the
  one-click model download, and all eleven model settings. If you had it on,
  `humanReplay.enabled` is now an unknown setting in your `settings.json` and can
  be deleted.
- Inline replay notes and the comments-to-prompt generator are gone, along with
  the four Comments: commands and the gutter comment bubble.
- Replay itself is untouched. Guide loading, the walk, diff-replay, Patch steps,
  resume, the guide panel, and every Tab keybinding behave exactly as they did.

## 0.5.0

Patch steps and create-file walks stop collapsing. A large or scattered Patch used
to land as one whole-file replace you Tabbed through unread, and a create-file walk
stalled on a member's multi-line doc comment. Both now disclose at the grain the
replay is for.

- A Patch step's line diff stays granular on large files. Above the old cell cap
  the diff fell back to a single file-sized replace; it now runs a linear-space
  pass that keeps the hunks tracking the real changed lines, so a scattered patch
  replays as scattered edits, not one block. An enormous mostly-rewritten middle
  still takes a deliberate coarse block rather than freezing the UI, and the widest
  hunk is logged so a coarse patch stays visible.
- A container member's leading doc comment or attribute discloses as one block with
  the member. It used to disclose line by line and stall, because adjacent comment
  lines repositioned the cursor onto itself and the next ghost never armed. The
  trivia now rides the member's step and Tab commits the block in one gesture.

## 0.4.1

Re-release of 0.4.0 so the Windows Marketplace package catches up. The 0.4.0 run
published the macOS and Linux packages, then the gallery timed out on Windows and
left it a version behind. No code changes from 0.4.0.

- The publish workflow now retries a timed-out upload with backoff and treats an
  already-published version as done, so one stuck platform no longer strands the
  rest and a partial failure self-heals on the next run.

## 0.4.0

Retrospective surfacing stops burying the code. Before, a Patch step anchored
its retrospective over the whole file, so the entire buffer went blue and there
was no way to clear it. Now the marker sits on the block being replayed.

- The retrospective squiggle covers only the block that step touched: the symbol
  for a symbol swap, the changed lines for a Patch step. A symbol swap also
  anchors on the new symbol length, so a length-changing modify marks the right
  span.
- Crossing a phase boundary clears the previous phase's retrospectives and
  invariants across every file it touched. Markers still persist within a phase
  so you can review it, then the slate wipes when you continue.
- Severity stays Information: the marker is still navigable from the Problems
  panel with F8, now without washing the whole file.

## 0.3.0

Guide discovery follows the new sandbox convention: `session/replay-guide.md`.

- The sandbox lookup, the workspace scan, and the sandbox picker all look for
  `session/replay-guide.md` first; the legacy `replay-guides/*.md` folder still
  works as a fallback, so older sandboxes replay unchanged.
- `humanReplay.guidePath` is untouched and still wins when set.

## 0.2.1

Docs-only release: rewrote the README so the Marketplace listing carries it.

## 0.2.0

The manual-testing release: full replays of a multi-phase C# guide drove
seventeen fixes across the engine and the feel.

- File walk: a new file discloses segment by segment (blank-line groups),
  never as one silent drop; a guide can split a multi-concept file into a
  skeleton plus per-symbol steps, each with its own retrospective.
- Container walk: classes, impls, and mods disclose shell-first, members one
  by one; walk layout is source-derived, so blank lines survive.
- Divergence: the caret never moves on a timer or selection event; the ghost
  waits and returns with your cursor; climb-outs arm Tab with a green landing
  preview; a dirty parse yields "no verdict", never a wrong container;
  recovery rebuilds are proven byte-exact by a dedicated oracle.
- Hunks: Shift+Escape skips one hunk (keeps your bytes); patch hunks ride the
  decoration surface with inline hints and a status-bar counter; Tab can
  never silently swallow a keystroke or type into an armed replay line.
- Sessions: phase boundaries pause with a persistent continue; step jumps
  land in back/forward history; End Replay Session and Resync Steps from
  Files; the Replay Guide view reveals itself on load; landed steps save and
  verify against the sandbox.
- Local model layer: turning autocomplete on walks server start, model choice
  (Fast/Smart), and a one-click cross-platform download; replay notes steer
  FIM suggestions; offline is a status-bar indicator, not a toast.

## 0.0.1

Initial release.

- Guide-driven, model-free replay of sandboxed agent work: Tab lands one AST
  node at a time, edits replay as inline decorations, surgical vs rewrite
  decided structurally.
- Languages: Rust, C#, TypeScript/JavaScript, Python, Markdown, HTML, CSS.
- Replay Guide explorer view with per-step run/skip, resume after interruption.
- Opt-in local model features via Ollama: FIM autocomplete and
  comments-to-prompt generation.
