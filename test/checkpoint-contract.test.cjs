// Adversarial oracles for phase checkpoints (src/disclosure/guide.ts, `checkpoints`).
//
// The checkpoint is what the phase-boundary pause SAYS. Two things make it
// dangerous. First, it sits in a markdown block that also carries the phase's
// understanding-check questions and the `> **Answer:**` line under each one, and
// the panel renders `tasks` verbatim: one leaked answer and the human is handed
// the conclusion before they have thought about the question, which is the whole
// point of the stop. Second, it sits between two phases, so a block reader that
// runs long eats the next phase's steps and the replay silently loses work.
//
// These cases are written against the format spec
// (human-replay/skills/generate-replay-guide/SKILL.md), not against the parser.
// Every one is a shape a real guide author produces: backticked test filters with
// brackets in them, a wrapped task, a fenced command block, a phase that closes
// with no checklist at all.
//
// Run: node --test test/checkpoint-contract.test.cjs

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".checkpoint.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/guide.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
});
const { parseGuide } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

// --- Fixture kit ---------------------------------------------------------
//
// Guides are built from line arrays so the expected line number is read off the
// fixture rather than hand-counted; a fixture edit then cannot quietly move the
// answer out from under the assertion.

const HEAD = ["# Replay: t", "", "## System Invariants", "", "- **Inv A:** reason a.", ""];

const guide = (...lines) => HEAD.concat(lines).join("\n") + "\n";

// A lean Modify step: File + Symbol, no fences. The shape the parser accepts and
// the shape every real machine-replayable guide uses.
const step = (id, extra = []) =>
  [
    `### Step ${id}: symbol ${id}`,
    "",
    "**File:** `src/wal.rs`",
    "**Action:** Modify",
    `**Symbol:** \`sym_${id.replace(/\./g, "_")}\``,
    "**Why:** w.",
  ]
    .concat(extra)
    .concat(["", "**Retrospective:** none", ""]);

const lineOf = (md, prefix) => md.split(/\r?\n/).findIndex((l) => l.startsWith(prefix)) + 1;

// No answer key, no section label, no question bullet may ever appear in a task.
// This is the leak assertion; it runs on every fixture that carries an answer.
function assertNoLeak(cp, label) {
  const joined = cp.tasks.join("\n");
  for (const banned of ["**Answer:**", "Understanding check", "Design critique", "Divergence notes"]) {
    assert.ok(!joined.includes(banned), `${label}: "${banned}" leaked into tasks:\n${joined}`);
  }
}

// --- The block boundary --------------------------------------------------

test("a step's own Verify checklist is not the phase's checkpoint", () => {
  // Every step carries `- [ ]` Verify bullets. A reader that scans the phase for
  // checklist lines instead of the checkpoint block turns each step's per-step
  // check into a phase-close task, and the human is told to re-run things they
  // already ran while the one task that matters is buried.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1", ["", "**Verify:**", "", "- [ ] Run `cargo check`.", "- [ ] Read the new test."]),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal_replay`. Expect 1 failure.",
  );
  const g = parseGuide(md);
  assert.strictEqual(g.checkpoints.length, 1);
  assert.deepStrictEqual(g.checkpoints[0].tasks, ["Run `cargo test wal_replay`. Expect 1 failure."]);
});

test("a checkpoint stops at the next phase heading and never eats its steps", () => {
  // The checkpoint sits between two phases. A block reader with no terminator
  // runs to end of file: the next phase's steps vanish from the counter and the
  // human never types them.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test`. Expect 1 failure.",
    "",
    "## Phase 2: The fix",
    "",
    ...step("2.1", ["", "**Verify:**", "", "- [ ] Run `cargo test`. Expect green."]),
  );
  const g = parseGuide(md);
  assert.deepStrictEqual(g.steps.map((s) => s.id), ["1.1", "2.1"]);
  assert.strictEqual(g.steps[1].phase, "Phase 2: The fix");
  assert.deepStrictEqual(g.checkpoints[0].tasks, ["Run `cargo test`. Expect 1 failure."]);
});

test("two checkpoints key to their own phases and do not pool their tasks", () => {
  // Task lists are per-phase. Pooled tasks mean the phase 1 pause shows work the
  // human cannot do yet, which trains them to ignore the panel.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal`. Expect 1 failure.",
    "",
    "## Phase 2: The fix",
    "",
    ...step("2.1"),
    "### CHECKPOINT: Phase 2 complete",
    "",
    "- [ ] Run `cargo test wal`. Expect green.",
    "- [ ] Run `cargo bench wal` and compare to the baseline.",
  );
  const g = parseGuide(md);
  assert.strictEqual(g.checkpoints.length, 2);
  assert.deepStrictEqual(
    g.checkpoints.map((c) => c.phase),
    ["Phase 1: Reproduction tests", "Phase 2: The fix"],
  );
  assert.deepStrictEqual(g.checkpoints[0].tasks, ["Run `cargo test wal`. Expect 1 failure."]);
  assert.deepStrictEqual(g.checkpoints[1].tasks, [
    "Run `cargo test wal`. Expect green.",
    "Run `cargo bench wal` and compare to the baseline.",
  ]);
});

test("a checkpoint keys to the phase it closes, not the first phase in the file", () => {
  // Phase 1 closes with prose and no checklist. A parser that keys checkpoints by
  // position in a phase list rather than by the heading above them hands phase 2's
  // red assertion to the phase 1 pause.
  const md = guide(
    "## Phase 1: Data models",
    "",
    ...step("1.1"),
    "## Phase 2: Reproduction tests",
    "",
    ...step("2.1"),
    "### CHECKPOINT: Phase 2 complete",
    "",
    "- [ ] Run `cargo test drop_tail`. Expect 2 failures.",
  );
  const g = parseGuide(md);
  assert.strictEqual(g.checkpoints.length, 1);
  assert.strictEqual(g.checkpoints[0].phase, "Phase 2: Reproduction tests");
});

test("a checkpoint before any phase heading keys to the literal \"Steps\"", () => {
  // A short guide has no phases at all; the panel still needs a key to file the
  // checkpoint under, and the tree uses "Steps" for the phaseless bucket.
  const md = guide(
    ...step("1.1"),
    "### CHECKPOINT: Ready",
    "",
    "- [ ] Run `cargo check`.",
  );
  const g = parseGuide(md);
  assert.strictEqual(g.checkpoints.length, 1);
  assert.strictEqual(g.checkpoints[0].phase, "Steps");
  assert.deepStrictEqual(g.checkpoints[0].tasks, ["Run `cargo check`."]);
});

test("multi-digit phase numbers carry the full heading text as the key", () => {
  // The key is the heading's title text, not a parsed number. A guide with ten
  // phases must not collapse `Phase 10` onto `Phase 1`.
  const md = guide(
    "## Phase 1: First",
    "",
    ...step("1.1"),
    "## Phase 10: Tenth",
    "",
    ...step("10.1"),
    "### CHECKPOINT: Phase 10 complete",
    "",
    "- [ ] Run `cargo test`.",
  );
  const g = parseGuide(md);
  assert.strictEqual(g.checkpoints[0].phase, "Phase 10: Tenth");
});

// --- The answer key must not reach the panel -----------------------------

test("question bullets and their answers are not tasks", () => {
  // The understanding check is read in the markdown, where the answer is one
  // deliberate scroll away. In the panel it would sit next to the question.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "**Understanding check:**",
    "",
    "- What does the tail record prove that a length check does not?",
    "  > **Answer:** that the writer acked bytes the reader cannot see.",
    "",
    "- Why does the reader stop one record short?",
    "  > **Answer:** the offset is computed before the record is validated.",
    "",
    "**Design critique:**",
    "",
    "- Is a sentinel the right shape here?",
    "  > **Answer:** the AI was probably right; a length prefix costs a second write.",
    "",
    "- [ ] Run `cargo test wal_replay_drops_tail`. Expect 1 failure.",
    "",
    "**Divergence notes:** _______________",
  );
  const g = parseGuide(md);
  const [cp] = g.checkpoints;
  assert.deepStrictEqual(cp.tasks, ["Run `cargo test wal_replay_drops_tail`. Expect 1 failure."]);
  assertNoLeak(cp, "mixed checkpoint");
  assert.ok(!cp.tasks.join("\n").includes("acked bytes"), "an answer body leaked without its label");
});

test("a checkpoint made only of questions and answers carries no tasks", () => {
  // Most phases are not test phases and close with nothing to run. The failure
  // mode here is not an empty panel, it is a panel full of answers.
  const md = guide(
    "## Phase 1: Data models",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "**Understanding check:**",
    "",
    "- Why is the offset a `u64` and not a `usize`?",
    "  > **Answer:** the file outlives the process that has a 32-bit pointer.",
  );
  const g = parseGuide(md);
  assert.strictEqual(g.checkpoints.length, 1, "the checkpoint still exists, it just has no tasks");
  assert.deepStrictEqual(g.checkpoints[0].tasks, []);
});

test("an answer blockquote sitting hard against a task does not join it", () => {
  // Guide authors write the answer directly under its line with no blank row.
  // A joiner that treats any indented follower as a continuation appends the
  // answer to the task and it renders in the panel.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal`. Expect 1 failure.",
    "  > **Answer:** the writer acked bytes the reader cannot see.",
    "- [ ] Step through `WalReader::next`.",
  );
  const g = parseGuide(md);
  const [cp] = g.checkpoints;
  assertNoLeak(cp, "tight answer");
  assert.deepStrictEqual(cp.tasks, [
    "Run `cargo test wal`. Expect 1 failure.",
    "Step through `WalReader::next`.",
  ]);
});

test("a wrapped task stops at the next bold field label", () => {
  // `**Divergence notes:**` closes the block in the template. Swallowed into the
  // last task it reads as part of the command the human is told to run.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal_replay_drops_tail`. Expect 1 failure: the replay",
    "      stops one record short. Green here means the test is not reproducing",
    "      the defect.",
    "",
    "**Divergence notes:** _______________",
  );
  const g = parseGuide(md);
  assert.deepStrictEqual(g.checkpoints[0].tasks, [
    "Run `cargo test wal_replay_drops_tail`. Expect 1 failure: the replay stops one record short. Green here means the test is not reproducing the defect.",
  ]);
});

test("a wrapped task whose continuation opens with a bold word keeps the word and stays one task", () => {
  // Wrapping is done by the author's editor at a column, so a continuation line
  // can start with `**never**` or `**Before**`. Dropping it because it looks like
  // a field label silently truncates the instruction mid-sentence.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run the suite twice and confirm the second run is",
    "      **never** faster than the first.",
  );
  const g = parseGuide(md);
  assert.deepStrictEqual(g.checkpoints[0].tasks, [
    "Run the suite twice and confirm the second run is **never** faster than the first.",
  ]);
});

// --- Task text is carried byte-for-byte, marker aside --------------------

test("a `- [x]` task is not carried, so the count never overstates what is left", () => {
  // Triage overruled the contract I was given here. Nothing in the panel owns
  // tick state: the status bar counts the tasks it holds and calls them all
  // outstanding. Carrying a ticked item means telling the human to run
  // something they already ran, which is a number that lies at them. Dropping
  // it makes the list shrink as they tick.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [x] Run `cargo check`.",
    "- [ ] Run `cargo test wal`. Expect 1 failure.",
  );
  const g = parseGuide(md);
  assert.deepStrictEqual(g.checkpoints[0].tasks, ["Run `cargo test wal`. Expect 1 failure."]);
});

test("brackets inside a backticked command survive the marker strip", () => {
  // Test filters and array indices put `[` and `]` in the task body. A greedy
  // marker regex re-matches inside the backticks and eats half the command the
  // human is supposed to paste.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test -- --skip [slow]` and read `records[0]` in the dump.",
    "- [ ] Confirm `- [ ]` renders literally in the panel.",
  );
  const g = parseGuide(md);
  assert.deepStrictEqual(g.checkpoints[0].tasks, [
    "Run `cargo test -- --skip [slow]` and read `records[0]` in the dump.",
    "Confirm `- [ ]` renders literally in the panel.",
  ]);
});

test("markdown emphasis in a task is preserved, not stripped", () => {
  // The panel decides how to render. The parser handing back de-emphasised text
  // loses the author's stress on the word that matters.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test` **before** touching `WalWriter`, not after.",
  );
  const g = parseGuide(md);
  assert.deepStrictEqual(g.checkpoints[0].tasks, [
    "Run `cargo test` **before** touching `WalWriter`, not after.",
  ]);
});

test("trailing whitespace on a task line is trimmed", () => {
  // Editors leave it behind. It shows up in the panel as a ragged right edge and
  // breaks any equality check a caller writes against the task text.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal`.   ",
  );
  const g = parseGuide(md);
  assert.deepStrictEqual(g.checkpoints[0].tasks, ["Run `cargo test wal`."]);
});

test("an indented sub-task is its own task, not a continuation of its parent", () => {
  // Authors nest the per-case checks under the command that runs them. Joined
  // into the parent they read as one impossible instruction; dropped, the human
  // never runs the cases.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal`. Expect 2 failures:",
    "  - [ ] `wal_replay_drops_tail`",
    "  - [ ] `wal_replay_short_read`",
  );
  const g = parseGuide(md);
  assert.deepStrictEqual(g.checkpoints[0].tasks, [
    "Run `cargo test wal`. Expect 2 failures:",
    "`wal_replay_drops_tail`",
    "`wal_replay_short_read`",
  ]);
});

// --- Fenced code inside a checkpoint -------------------------------------

test("a fence inside a checkpoint hides task markers and headings from the parser", () => {
  // A checkpoint that shows the expected failure output quotes real test stdout,
  // and test stdout contains lines starting with `- [ ]` and `###`. Parsed as
  // markdown they become phantom tasks and a phantom second checkpoint.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal` and match the output below.",
    "",
    "```text",
    "",
    "### CHECKPOINT: nor is this a checkpoint",
    "",
    "- [ ] this is stdout, not a task",
    "",
    "```",
    "",
    "- [ ] Step through `WalReader::next`.",
  );
  const g = parseGuide(md);
  assert.strictEqual(g.checkpoints.length, 1, "the fenced heading became a second checkpoint");
  assert.deepStrictEqual(g.checkpoints[0].tasks, [
    "Run `cargo test wal` and match the output below.",
    "Step through `WalReader::next`.",
  ]);
});

test("a checkpoint's tasks span every labelled sub-section of the block", () => {
  // The template splits the block into an understanding check, the red assertion,
  // and claimed-safe properties, each with its own bold label. All of the `- [ ]`
  // lines are things to run, wherever in the block they sit; a reader that stops
  // at the first bold label after the first task drops the safety claims, which
  // are the ones nobody thinks to check.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal`. Expect 1 failure.",
    "",
    "**Claimed-safe properties:**",
    "",
    "- [ ] Run `cargo bench read_path`. Expect within 2% of the baseline.",
    "- [ ] Run `cargo test --test compat`. Expect 41 passing.",
    "",
    "**Divergence notes:** _______________",
  );
  const g = parseGuide(md);
  assert.deepStrictEqual(g.checkpoints[0].tasks, [
    "Run `cargo test wal`. Expect 1 failure.",
    "Run `cargo bench read_path`. Expect within 2% of the baseline.",
    "Run `cargo test --test compat`. Expect 41 passing.",
  ]);
});

test("a fenced `### CHECKPOINT` inside a step body does not invent a checkpoint", () => {
  // The guide that documents this format quotes the checkpoint shape in a fence.
  // A line-prefix scan that ignores fences reads the example as the real thing.
  const md = guide(
    "## Phase 1: Docs",
    "",
    "### Step 1.1: document the format",
    "",
    "**File:** `src/wal.rs`",
    "**Action:** Modify",
    "**Symbol:** `sym_doc`",
    "**Why:** the format needs an example.",
    "",
    "**After:**",
    "```markdown",
    "### CHECKPOINT: Phase N complete",
    "",
    "- [ ] Run the suite.",
    "```",
    "",
    "**Retrospective:** none",
  );
  const g = parseGuide(md);
  assert.deepStrictEqual(g.checkpoints, []);
});

// --- Line numbers ---------------------------------------------------------

test("checkpoint.line is the 1-based line of the CHECKPOINT heading", () => {
  // The panel opens the guide at this line. Off by one and the human lands on a
  // blank row above the block they asked to read.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal`.",
  );
  const expected = lineOf(md, "### CHECKPOINT:");
  assert.ok(expected > 0, "fixture lost its checkpoint heading");
  assert.strictEqual(parseGuide(md).checkpoints[0].line, expected);
});

test("checkpoint.line survives an earlier fence that contains blank-looking headings", () => {
  // Lines consumed by a fence still count. A parser that strips fences before
  // numbering reports a line short of the real one, and the further down the
  // guide the checkpoint sits the worse the miss.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    "### Step 1.1: first",
    "",
    "**File:** `src/wal.rs`",
    "**Action:** Modify",
    "**Symbol:** `sym_1_1`",
    "**Why:** w.",
    "",
    "**After:**",
    "```rust",
    "// ### Step 9.9: not a step",
    "fn f() {}",
    "```",
    "",
    "**Retrospective:** none",
    "",
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal`.",
  );
  const g = parseGuide(md);
  assert.strictEqual(g.checkpoints[0].line, lineOf(md, "### CHECKPOINT:"));
  assert.strictEqual(g.steps.length, 1, "the fenced step heading became a step");
});

// --- Line endings ---------------------------------------------------------

test("a CRLF guide parses identically to the LF one, carriage returns and all", () => {
  // Guides are written on Windows and land in the repo with CRLF. A parser that
  // splits on \n leaves \r on the tail of every field: the task text ends in an
  // invisible control character, and a `line` computed from the wrong split is wrong.
  const lf = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal_replay`. Expect 1 failure: the replay",
    "      stops one record short.",
    "- [x] Read `WalReader::next`.",
  );
  const crlf = lf.replace(/\n/g, "\r\n");
  const a = parseGuide(lf);
  const b = parseGuide(crlf);
  assert.deepStrictEqual(b.checkpoints, a.checkpoints);
  for (const t of b.checkpoints[0].tasks) {
    assert.ok(!t.includes("\r"), `carriage return survived in task: ${JSON.stringify(t)}`);
  }
  assert.strictEqual(b.checkpoints[0].phase, "Phase 1: Reproduction tests");
  assert.strictEqual(b.checkpoints[0].line, lineOf(crlf, "### CHECKPOINT:"));
});

// --- Optionality: a checkpoint is never required --------------------------

test("a guide with no checkpoints parses with an empty list and never throws", () => {
  // Every guide written before checkpoints existed is still on disk and still
  // loadable. A parser that demands one breaks every one of them at once.
  const md = guide("## Phase 1: Reproduction tests", "", ...step("1.1"));
  const g = parseGuide(md);
  assert.deepStrictEqual(g.checkpoints, []);
  assert.strictEqual(g.steps.length, 1);
});

test("the word CHECKPOINT in ordinary prose is not a checkpoint", () => {
  // A step's Why can talk about the checkpoint it precedes. Only the heading is
  // the heading.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    "### Step 1.1: first",
    "",
    "**File:** `src/wal.rs`",
    "**Action:** Modify",
    "**Symbol:** `sym_1_1`",
    "**Why:** the CHECKPOINT: below tells the human to run this red.",
    "",
    "**Retrospective:** none",
  );
  assert.deepStrictEqual(parseGuide(md).checkpoints, []);
});

test("a checkpoint with a heading and nothing under it parses without throwing", () => {
  // An author writes the heading, then gets pulled away. A parse error here takes
  // the whole guide down over a block that carries no instruction either way.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
  );
  let g;
  assert.doesNotThrow(() => {
    g = parseGuide(md);
  });
  assert.strictEqual(g.steps.length, 1);
  for (const cp of g.checkpoints) assert.deepStrictEqual(cp.tasks, []);
});

// --- Shape variants the contract does not pin, but which must stay safe ----

test("a `## CHECKPOINT` at the wrong heading level never swallows the phase below it", () => {
  // The contract names `### CHECKPOINT:`. A typo at `##` is either ignored or
  // read as a checkpoint; both are survivable. What is not survivable is the
  // block running on into phase 2 and taking its step with it, or the phase key
  // for a later checkpoint shifting onto the typo.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "## CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal`. Expect 1 failure.",
    "",
    "## Phase 2: The fix",
    "",
    ...step("2.1"),
    "### CHECKPOINT: Phase 2 complete",
    "",
    "- [ ] Run `cargo test wal`. Expect green.",
  );
  const g = parseGuide(md);
  assert.deepStrictEqual(g.steps.map((s) => s.id), ["1.1", "2.1"]);
  assert.strictEqual(g.steps[1].phase, "Phase 2: The fix");
  const phase2 = g.checkpoints.find((c) => c.tasks.some((t) => t.includes("Expect green")));
  assert.ok(phase2, "the phase 2 checkpoint went missing");
  assert.strictEqual(phase2.phase, "Phase 2: The fix", "a mislevelled heading captured phase 2's key");
});

test("a lowercase `### Checkpoint:` heading never leaks answers whichever way it is read", () => {
  // Case is the author's slip, not the human's problem. Ignored is fine, matched
  // is fine. Matched-but-sloppy is not: the block under it carries an answer.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### Checkpoint: Phase 1 complete",
    "",
    "- Why does the replay stop short?",
    "  > **Answer:** the offset is computed before the record is validated.",
    "",
    "- [ ] Run `cargo test wal`. Expect 1 failure.",
  );
  const g = parseGuide(md);
  assert.strictEqual(g.steps.length, 1, "the heading stole the step");
  for (const cp of g.checkpoints) assertNoLeak(cp, "lowercase heading");
});

test("the CHECKPOINT heading's own title is not a task", () => {
  // "Phase 1 complete" is a label, not something the human does. In the task list
  // it reads as an instruction to declare the phase done before running anything.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    ...step("1.1"),
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal`.",
  );
  const g = parseGuide(md);
  assert.ok(
    !g.checkpoints[0].tasks.some((t) => t.includes("Phase 1 complete")),
    "the heading text became a task",
  );
});

// --- Existing behaviour is untouched --------------------------------------

test("a guide carrying a checkpoint still parses its steps, invariants and fences", () => {
  // The checkpoint is additive. If reading it costs a step, an invariant link, or
  // a byte of the After fence, the feature is a regression wearing a panel.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    "### Step 1.1: first",
    "",
    "**Symbol:** `f`",
    "**Action:** Create",
    "**Invariants:** Inv A",
    "**Why:** w.",
    "",
    "**After:**",
    "```rust",
    "fn f() -> u64 {",
    "    0",
    "}",
    "```",
    "",
    "**Retrospective:** Why zero?",
    "",
    "> **Answer:** an empty log replays to offset zero.",
    "> **Distractor:** the type is unsigned so zero is the only safe default.",
    "> **Distractor:** the caller always overwrites it.",
    "",
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal`.",
  );
  const g = parseGuide(md);
  assert.strictEqual(g.feature, "t");
  assert.deepStrictEqual(g.invariants.map((i) => i.rule), ["Inv A"]);
  assert.strictEqual(g.steps.length, 1);
  const [s] = g.steps;
  assert.strictEqual(s.action, "create");
  assert.strictEqual(s.after, "fn f() -> u64 {\n    0\n}");
  assert.strictEqual(s.phase, "Phase 1: Reproduction tests");
  assert.deepStrictEqual(s.retro.invariants.map((i) => i.rule), ["Inv A"]);
  assert.strictEqual(s.retro.choices.length, 3, "the checkpoint ate the step's answer key");
  assert.strictEqual(s.retro.choices.filter((c) => c.correct).length, 1);
  assert.deepStrictEqual(g.checkpoints[0].tasks, ["Run `cargo test wal`."]);
});

test("a step's answer key is never re-read as the checkpoint's tasks", () => {
  // The step blockquote and the checkpoint block are both `>`-and-`-` soup sitting
  // a few lines apart. A checkpoint reader that starts from the phase heading
  // instead of its own heading picks up the distractors, and the panel shows the
  // human two wrong answers labelled as things to do.
  const md = guide(
    "## Phase 1: Reproduction tests",
    "",
    "### Step 1.1: first",
    "",
    "**File:** `src/wal.rs`",
    "**Action:** Modify",
    "**Symbol:** `sym_1_1`",
    "**Why:** w.",
    "",
    "**Retrospective:** Why zero?",
    "",
    "> **Answer:** an empty log replays to offset zero.",
    "> **Distractor:** the type is unsigned.",
    "> **Distractor:** the caller overwrites it.",
    "",
    "### CHECKPOINT: Phase 1 complete",
    "",
    "- [ ] Run `cargo test wal`.",
  );
  const g = parseGuide(md);
  const joined = g.checkpoints[0].tasks.join("\n");
  assert.ok(!joined.includes("Distractor"), `a step distractor leaked into tasks:\n${joined}`);
  assert.ok(!joined.includes("empty log"), `a step answer leaked into tasks:\n${joined}`);
  assert.deepStrictEqual(g.checkpoints[0].tasks, ["Run `cargo test wal`."]);
});
