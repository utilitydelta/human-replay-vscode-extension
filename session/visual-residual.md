# Visual residual — what F5 has to prove

No oracle can reach any of this. The extension host is not headless-testable, so
every surface below is unverified by the suite and is where the remaining bugs
live.

## The one that matters: does it still activate?

Nothing in the test suite loads `extension.ts` (it imports `vscode`). The
manifest and the bundle are proven consistent, the registration cross-check is
clean, but "the extension activates without throwing" is only provable by
running it.

**Drive it:** F5 from this repo, then in the Extension Development Host open the
"Human Replay" output channel. Expect one line: `[human-replay] activated`. An
activation throw shows as a notification and an empty channel.

## Screens changed

| Surface | What changed | How to reach it |
| --- | --- | --- |
| Command palette | 7 commands gone: Toggle Autocomplete, the two Autocomplete: commands, and the four Comments: commands. 9 remain. | `Ctrl+Shift+P`, type "Human Replay" |
| Settings UI | 11 model settings gone. 3 remain: guidePath, sandboxRoot, sandboxParent. | Settings, search "Human Replay" |
| Editor gutter | The comment-thread `+` bubble on hover is gone (the commenting range provider was the whole file, so it appeared on every line of every file). | Hover any line's gutter in any file |
| Status bar (right) | The "autocomplete offline" plug indicator can no longer appear. | Previously showed whenever Ollama was down |
| Status bar (left) | Unchanged. Program counter, phase pause, patch pause all intact. | Load a guide |

## Journeys to walk

1. **The hero path, unchanged.** Start Replay, pick a sandbox, load its guide,
   Tab through a create step, a modify step, and a Patch step. This is the whole
   product now; if it works, the goal is met.
2. **Ghost text still renders.** The provider that draws it was rewritten. The
   insert walk's next AST node and diff-replay's next hunk both come through it.
   If ghosts appear and Tab commits them, the rewrite is sound.
3. **No stray ghost when idle.** With no replay running, type in a normal file.
   Expect nothing — no suggestion, no request, no delay. The old provider had a
   FIM branch here; the new one returns early.
4. **Retrospectives still fire** (kept on purpose). Finish a step that carries
   one; the squiggle should land on the block that step touched, and clear at
   the phase boundary.
5. **Patch pause Tab.** The 0.5.1 fix. Reach a paused Patch step, press Tab,
   confirm it arms the patch instead of typing an indent.

Rigs and reset recipe: the demo repos noted in the human's memory.
