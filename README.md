# Human Replay

Land AI-generated work in your real branch one Tab press at a time.

You let an agent run free in a sandbox copy of your repo. Human Replay walks the
result back into your real branch step by step: press Tab, the next piece of the
change lands, you read it, you keep going or take over and type. Every byte that
lands is a real byte from the sandbox or your branch. No model sits between you
and the diff.

## How it works

- A replay guide (a Markdown file of ordered steps) describes the work; the
  sibling scout tooling generates it from a sandbox session.
- The extension resolves each step's bytes structurally with tree-sitter from
  the sandbox tree and your open file, then replays them: new code walks in one
  AST node at a time, edits show as inline decorations you accept with Tab.
- Step routing, resume after interruption, and the surgical-vs-rewrite decision
  are all computed model-free from the AST. You ratify each one at the keyboard.

## Getting started

1. Run **Human Replay: Start Replay** from the command palette.
2. Pick the sandbox to replay from. `humanReplay.sandboxParent` sets where
   sandboxes live (defaults to `~/sandbox`); `humanReplay.guidePath` points at a
   guide directly (defaults to the workspace's `replay-guides/` folder).
3. Tab lands each step. Shift+Escape skips one hunk (your bytes stay); Escape
   cancels the current step. The replay pauses at each phase boundary — the
   status bar and the Replay Guide view carry the continue.
4. The Replay Guide view in the explorer shows progress and re-runs any step;
   every engine decision is logged in the "Human Replay" output channel. After
   a rollback, **Resync Steps from Files** re-reads every step's status from
   disk.

## Languages

Rust, C#, TypeScript/JavaScript (tsx/jsx included), Python, Markdown, HTML,
and CSS. In HTML, elements are addressed by `tag#id` (plus the spec-unique
tags like `body`); in CSS, rules and at-rule groups are addressed by their
selector or condition text.

## Optional local model features

Two features, both off by default, call a local Ollama instance. Nothing else
does; replay itself never calls a model.

- **FIM autocomplete**: inline completions from a local base model. Replay
  notes near the cursor are woven into the prompt, so a note like "filter out
  anything over 100 dollars" steers the suggestion.
- **Comments to prompt**: collates your replay notes into a prompt for the next
  sandbox session using a local instruct model (`humanReplay.promptModel`).

Turning autocomplete on walks the setup for you: one click starts the model
server, one picks a model size (Fast/Smart), one downloads it — on any OS.
Nothing model-shaped ever happens without a click; if the server goes away,
a status-bar indicator brings it back.

## License

Apache-2.0
