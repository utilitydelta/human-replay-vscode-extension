# Changelog

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
