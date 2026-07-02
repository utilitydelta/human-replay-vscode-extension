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
3. Tab lands each step. Escape cancels. The Replay Guide view in the explorer
   shows progress, and every engine decision is logged in the "Human Replay"
   output channel.

## Languages

Rust, C#, TypeScript/JavaScript (tsx/jsx included), Python, and Markdown.

## Optional local model features

Two features, both off by default, call a local Ollama instance. Nothing else
does; replay itself never calls a model.

- **FIM autocomplete**: inline completions from a local base model
  (`humanReplay.model`, e.g. `qwen2.5-coder:1.5b-base`).
- **Comments to prompt**: collates your replay notes into a prompt for the next
  sandbox session using a local instruct model (`humanReplay.promptModel`).

The extension never starts Ollama for you. If it is unreachable, autocomplete
turns itself off until it returns.

## License

Apache-2.0
