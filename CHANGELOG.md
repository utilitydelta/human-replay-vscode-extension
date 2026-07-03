# Changelog

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
