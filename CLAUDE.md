# Human Replay VS Code extension — agent operating guide

The human half of Human Replay: a VS Code extension that replays sandboxed agent
work into the real branch one AST node at a time, on the Tab key. The scout half
(sandbox prep, guide generation) is the sibling repo `human-replay`.
Formerly `celeriant-tab`; that repo holds the build history and doc tree.

Docs are the human's job. This file is the only doc agents maintain; do not add
a README or guides unless asked.

## Non-negotiables (the invariants the design rests on)

A change that violates one of these is drift, not a feature.

- **Model-free hero path.** Disclosure, diff-replay, the surgical/rewrite
  cutover, routing, resume, and anchors never call a model. The model is an
  opt-in aid on exactly two paths: FIM autocomplete and the comments-to-prompt
  generator. Never put inference on a replay or routing decision.
- **Ground truth.** Every token the human lands is a real sandbox or branch
  byte. The diff invents nothing in either direction; the oracles assert
  byte-exactness. When bytes can't be proven to belong somewhere, surface to
  the human — never guess.
- **The guide is canonical.** The parser here is the single source of truth for
  the guide format. The generator spec in `human-replay` describes it; a format
  change lands in both repos in the same sitting. A malformed guide fails loud.
- **The human decides; the AST proposes.** Surgical vs rewrite, step routing,
  resume verdicts — all computed model-free and ratified by the human at the
  keyboard.
- **Opt-in model layer.** Off on first open. Never auto-spawn Ollama and never
  auto-pull a model; detect and guide — one-click gestures (start the server,
  download the model) the human ratifies.

## Conventions

- `npm test` (node:test, esbuild-bundled oracles in `test/*.test.cjs`) stays
  green; `npm run typecheck` and `npm run build` stay clean. Commit each green
  increment; work lands on `main`.
- Languages: Rust, C#, TypeScript/JavaScript (tsx/jsx included), Python,
  Markdown (items are heading sections), HTML (items are id'd elements plus
  the spec-unique tags), and CSS (items are rules/at-rule groups named by
  prelude text). All per-language knowledge lives in
  `src/disclosure/language.ts`; the rest of the engine is language-agnostic.
  Python, Markdown, HTML, and CSS have no create walk — creates land
  whole-symbol.
- Native `tree-sitter` + every grammar is externalized in every esbuild call
  (the extension bundle, every test bundle, `scripts/validate-guide.js`).
  Adding a grammar means adding it to every externals list. Wasm is for
  `.vsix` packaging only.
- A code path isn't finished when it compiles; it's finished when it emits
  evidence — a green oracle, or a span in the "Human Replay" output channel.
  Every engine decision already logs there (`[guide]`, `[replay]`,
  `[diff-replay]`); match that.
- Pure logic lives out of `vscode`-coupled files so it bundles headless. The
  pattern is everywhere: controller in `src/`, oracle in `test/`.
- Feel is a first-class gate. Rendering and gesture changes get an F5 check by
  the human; say so in the handoff rather than calling them done.

## File map

- `src/disclosure/` — the engine. Insert walk: `walk.ts`, `session.ts`,
  `controller.ts`. Edit-aware: `diff.ts`, `replay.ts`, `sequence.ts`,
  `strategy.ts`, `diffReplayController.ts`, `orchestrator.ts`. Patch steps
  (line-grain, below symbol grain): `lineDiff.ts`. File walk (create-file
  discloses by blank-line groups): `fileWalk.ts`. Guide:
  `guide.ts` (parser), `guideRunner.ts` (program counter + routing + resume +
  phase-boundary pause), `resume.ts`, `programCounter.ts`, `guideTree.ts`.
  Surfacing: `comments.ts`, `commentAnchor.ts`, `promptgen.ts`,
  `actionability.ts`.
- `src/` — FIM autocomplete (completionProvider, ollama, templates,
  postprocess, config, modelPull for the one-click download) beside the
  extension entry.
- `test/*.test.cjs` — headless oracles, parameterized over corpora, each naming
  the invariant it proves.
- `scripts/validate-guide.js` — the guide oracle: parses with the real parser,
  resolves every step's bytes from target + sandbox, replays modify steps
  through the controller's exact sequential policy. Guide authors (human or
  agent) iterate against it until PASS.
- `replay-guides/asymmetric-fencing.md` — the shipped self-contained guide the
  parser test guards; also the demo.

## Tooling notes

- `qdrant-find` collection follows the folder name
  (`human-replay-vscode-extension`); if the collection doesn't exist yet, grep.
- The build-method skills (`~/work/utilitydelta/build-method/skills/`) apply:
  `empirical-loop` before any non-trivial build, `coding-style` +
  `references/typescript.md` for the code, `unit-testing-discipline` for
  oracles, `comment-discipline` for comments, `writing-style` for all prose.
