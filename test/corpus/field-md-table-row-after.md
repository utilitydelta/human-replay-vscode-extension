# Architecture

## Subsystem map

| Subsystem | One line | Doc |
|---|---|---|
| FIM completion | Debounced, cached, single-flight ghost text from the small base model, with language-server candidate injection and the member-name output gate at member sites | [docs/architecture/fim-completion.md](docs/architecture/fim-completion.md) |
| Function generation | Span-bounded body generation with preview-and-confirm through the single write path, per-language type (class/record/struct/enum/interface) generation, the Python docstring read as the spec and preserved outside the generated span, plus the TDD test gesture | [docs/architecture/fn-generation.md](docs/architecture/fn-generation.md) |
| Context blocks | The ordered, user-curated live ranges that are the only prompt context, resolved against the live document at generate time | [docs/architecture/context-blocks.md](docs/architecture/context-blocks.md) |
| Compiler oracle + repair | Per-language verify-and-surface (cargo, tsc, dotnet, pyright), the capped, routed, span-scoped repair state machine, and the manual refine gesture on a clean build. The repo-usage leg is refine-ALWAYS and repair-OPT-IN (`column80.repairUsageWindows`, default off): it lost its arm on repair rounds and the doc carries the numbers | [docs/architecture/compiler-oracle.md](docs/architecture/compiler-oracle.md) |
| Surface injection | The compiler-directed loop: resolve real API from the language server and inject it, directed by the compiler's error class | [docs/architecture/surface-injection.md](docs/architecture/surface-injection.md) |
| Hardware tiers + carve | Probe, tier table, the VRAM carve, and the ratified pull flow | [docs/architecture/hardware-tiers.md](docs/architecture/hardware-tiers.md) |
| VS Code layer | Wiring, evidence channel, the core/vscode split, and the test harness | [docs/architecture/vscode-layer.md](docs/architecture/vscode-layer.md) |
| TDD language seam | The contract every language leg of the test-authoring gesture is built to: placement, runner command, the three no-run outcomes, the blank-value rule, and the per-language locators | [docs/architecture/tdd-language-seam.md](docs/architecture/tdd-language-seam.md) |
| Tighten Doc Comment | The re-wrap and backtick gesture: the fold, the workspace-symbol existence gate and its measured cost, the delta census behind the eviction argument, and the two prose flags | [docs/architecture/tighten-doc-comment.md](docs/architecture/tighten-doc-comment.md) |
| Criticize | The read-only grading gesture: fourteen deterministic rubric dimensions across five languages, the blast radius, and the one-way door that stops the model deciding what a finding is | [docs/architecture/criticize.md](docs/architecture/criticize.md) |
| Dictation | Say what the next block does: a resident whisper.cpp hears it, the sentence rides one FIM request as a comment the file never sees, and the accept lands the cursor on a fresh line | [docs/architecture/dictation.md](docs/architecture/dictation.md) |

Layout rule underneath all of it: `src/core/` never imports `vscode` and holds every decision; `src/vscode/` is adapters and wiring. That split is what makes the contract oracles runnable headless.

A user-facing manual lives at [docs/user-manual.md](docs/user-manual.md).
