# Dictate the next block

## The recogniser and the recorder

whisper.cpp's `whisper-server`, vendored per platform and pinned by tarball hash, resident from
activation on a free loopback port. Resident is the whole design: a per-gesture spawn pays 0.5
to 0.7s of model load and misses the bar; warm, a six second take decodes in about 250ms on the
reference box and the server itself comes up in about 80ms because it maps the model. Beam 5 on
every request, because greedy decoding turned "threat level" into "THREKT LEVEL" on a clean
fixture and beam 5 cost nothing measurable. Silero VAD rides along when its 0.9MB file is
present, because three seconds of digital silence decoded to "You" without it and to nothing
with it. The decoder is not run-to-run stable on identical bytes at eight threads ("two"
against "2" alternated on one fixture); nothing in the product asserts on exact transcript text.

The model (`ggml-base.en.bin`, 148MB, sha256 pinned) downloads through a ratified toast like
every ollama model: `[dictate] model offered`, `ratified` before the request starts,
`declined`, `done`, `failed`. It streams to a `.part` file and renames on success; presence is
checked by size, not by hash, on every activation.

`column80-capture` is one C program over miniaudio: `--list` prints the capture devices as
JSON, otherwise it streams 16kHz mono s16le on stdout until stdin closes and drains its ring
once more after the device stops, so the last word is never the one lost. It links libc and
libm only; miniaudio loads the OS backend at runtime. The null backend is compiled out, so a
box with no audio stack exits 2 with a sentence instead of capturing silence. A named
`--device` that is not present exits 5; there is no silent fall-back to the default. Measured on
this box from the extension: press to first buffer 39 to 170ms, higher on the first spawn of a
session; chunks every 20ms.

The speakers are muted for the take and restored only if this muted them: `wpctl` then `pactl`
on Linux, `osascript` on macOS, nothing yet on Windows (the channel says so). Setting
`column80.dictation.muteSpeakers`, default on.

Every signal to a child goes through `signalChild` (`src/core/signalChild.ts`), which sends
nothing when the child has no pid. Why: Node keeps a ChildProcess whose spawn failed open until
the `error` event lands on the next tick and never writes a pid into it, so `kill()` on that
handle reaches the kernel with whatever bytes sat in the field. Measured under strace on node
24: `kill(995632904, SIGKILL)`. The outcome was a draw each time: ESRCH and nothing, or a
process of the same user killed (the unit runner locally, the hosted CI agent once, hence a 45
minute job with no log), or EPERM making Node emit a second `error` so the real ENOENT was
thrown into the test with no listener. The window in the product is a recorder that failed to
spawn (deleted between the readiness check and the press, EACCES, EAGAIN) followed by Escape
while arming. `CaptureTake.abort()` now returns whether it signalled, the grace timer in
`stop()` takes the same guard, and so do the recogniser's deadline kill and `dispose()`, the
Claude Code instruct child's abort, the hardware probe and the four LSP clients' `dispose()`.
The rows are `test/blind-v67-p0-kill.test.cjs` (a missing path then `abort()` returns false,
throws nothing, settles `binary-missing`; the fake recorder returns true; a strace witness with
no `kill(` line when strace is on the box) and `test/review-v66-p12.test.cjs` twenty times
green, the file that used to kill its own runner one run in five.

## Gesture 2, first half: dictate a declaration

`src/core/dictationDoc.ts`. At a blank line that fn-gen's resolver says is not inside a function
(`resolveFunctionAtCursor` returns nothing), the sentence is the doc comment and stays. The model
sees it above the cursor in the language's doc form (`docCommentAbove`: `///` for Rust and C#,
`//` for Go, `/** */` for the TypeScript family; Python's docstring goes inside the body, so the
model sees the line comment there). The served head is dressed by `declarationGhost` into one
item: the doc comment, the head, and where the head opens a body an empty body line at one more
indent unit plus the closer (a docstring line in Python), with the caret offset the accept
command then honours. One accept, one write path, the comment kept because it is part of the
ghost. The scout's measurement on 100 documented Rust heads (doc comment present: 81 declare,
31 name right, 16 whole head within 0.9) is the ceiling this half ships at.

The accept runs through `column80.fimAccepted`, so the compiler check and the repair loop
already run on the landed head: on 2026-09-02 the human dictated the doc comment of
`endOfLiteral` in `src/core/brackets.ts`, the head landed, tsc went red on the empty body, and
repair wrote the body. What roadmap item 78 still owes is the dictated name and parameter list
matched rather than guessed, and the fifty-gesture falsifier. A head that opens no body (a type
alias, `struct Foo;`, a trait method) lands with the caret at its end at module level, or on a
fresh line at the block's indent inside a block. A dictated request reads through attribute and
decorator lines (`#[derive(Debug)]`, `[Serializable]`, `@dataclass`) to the head under them
(`headThroughAttributes` on the bound); before session-v66 a dictated Rust enum landed the doc
comment over a bare `#[derive(Debug)]`.

