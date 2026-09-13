// Adversarial oracles for the phase checkpoint (commit 6efaa2d).
//
// Each test asserts the CONTRACT the change signed up for, not the behaviour it
// happens to have. The contracts are:
//   - session-v3/goal.md constraint 2: the answers written beside the
//     checkpoint's questions never reach a panel.
//   - generate-replay-guide SKILL.md rule 8: a phase's `### CHECKPOINT:` block is
//     parsed, and only its `- [ ]` lines are.
//   - SKILL.md "Order by dependency" / the claimed-safe-properties template: the
//     checkpoint "names the command and the expected number".
//   - CLAUDE.md invariant "the guide is canonical": a malformed guide fails loud;
//     it does not silently drop what the author wrote.
//
// A failing test here is the defect. Tests named "(no defect)" pass and are kept
// so the report can say what was checked and found clean.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".adversarial-checkpoint.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/guide.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
});
const { parseGuide } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

// A two-phase guide with a checkpoint body the caller supplies.
const GUIDE = (checkpointBody, opts = {}) =>
  `# Replay: t

## System Invariants

- **Inv A:** reason a.

## Phase 1: Reproduction tests

### Step 1.1: wal_replay_drops_tail

**File:** \`src/wal.rs\`
**Action:** Create
**Symbol:** \`wal_replay_drops_tail\`
**Why:** the defect needs a witness before it has a fix.

**Retrospective:** none

### CHECKPOINT: Phase 1 complete

${checkpointBody}
${opts.tail ?? ""}
## Phase 2: The fix

### Step 2.1: next

**File:** \`src/wal.rs\`
**Action:** Modify
**Symbol:** \`next\`
**Why:** the tail offset was computed before the record was validated.

**Retrospective:** none
`;

// The runner's lookup, verbatim from guideRunner.ts:651 —
//   return this.guide?.checkpoints.find((c) => c.phase === label);
// The tree asks the same question (guideTree.ts:68, :73, :120). Modelled here
// because guideRunner.ts imports `vscode` and does not bundle headless.
const checkpointFor = (guide, phase) => guide.checkpoints.find((c) => c.phase === (phase ?? "Steps"));

// ---------------------------------------------------------------------------
// 1. The answer key. goal.md constraint 2 is absolute: never a panel, never a toast.
// ---------------------------------------------------------------------------

// SKILL.md's own checkpoint template writes the answer as a `>` blockquote line
// directly under the bullet it answers ("Checkpoint questions keep the bare
// answer"). Apply that to a `- [ ]` claimed-safe property — the one bullet kind
// the template says MUST be a task — and the answer rides into the task text.
const ANSWER_UNDER_TASK = GUIDE(`**Claimed-safe properties:**

- [ ] Run \`cargo bench wal_append\`; p99 within 5% of the 1.8ms baseline.
  > **Answer:** the guard is off the hot path, so append throughput is unchanged.

**Divergence notes:** _______________
`);

test("ADV-1 an answer blockquote under a `- [ ]` task never reaches the task text", () => {
  const cp = parseGuide(ANSWER_UNDER_TASK).checkpoints[0];
  assert.deepStrictEqual(cp.tasks, [
    "Run `cargo bench wal_append`; p99 within 5% of the 1.8ms baseline.",
  ]);
});

test("ADV-2 the leaked answer would be the toast text (guideRunner.ts:553 `check?.tasks[0]`)", () => {
  const cp = parseGuide(ANSWER_UNDER_TASK).checkpoints[0];
  const toast = `Human Replay: Phase 1: Reproduction tests complete. ${cp.tasks[0]}`;
  assert.ok(!/Answer/i.test(toast), `answer key in the toast: ${toast}`);
});

// ---------------------------------------------------------------------------
// 2. Fences. parseTasks (guide.ts:339) has no fence state; splitSections does.
// ---------------------------------------------------------------------------

const FENCED = GUIDE(`- [ ] Run the suite and watch all three fail:
\`\`\`bash
cargo test -p wal -- --nocapture
\`\`\`
- [ ] Step through \`WalReader::next\`.
`);

test("ADV-3 a fenced command block under a task is not folded into the task text", () => {
  const cp = parseGuide(FENCED).checkpoints[0];
  assert.ok(
    !cp.tasks[0].includes("```"),
    `fence markers folded into the task: ${JSON.stringify(cp.tasks[0])}`,
  );
});

// A checkpoint that quotes guide markdown (this repo's own change is exactly
// such a guide). The fenced `- [ ]` line is BYTES, not a task.
const FENCE_PHANTOM = GUIDE(`- [ ] Run \`npm test\`. Expect 3 failures in guide.test.cjs.

The shape the parser must read:

\`\`\`markdown
### CHECKPOINT: Phase 1 complete

- [ ] this line is a sample, not a task
\`\`\`
`);

test("ADV-4 a `- [ ]` line inside a fenced block is not read as a task", () => {
  const cp = parseGuide(FENCE_PHANTOM).checkpoints[0];
  assert.deepStrictEqual(cp.tasks, ["Run `npm test`. Expect 3 failures in guide.test.cjs."]);
});

// ---------------------------------------------------------------------------
// 3. Sub-bullets. SKILL.md:570 — the checkpoint "names the command and the
//    expected number". A task whose numbers are sub-bullets loses the numbers.
// ---------------------------------------------------------------------------

const SUBBULLETS = GUIDE(`- [ ] Run \`cargo bench wal_append\`. Expect:
  - p99 within 5% of the 1.8ms baseline
  - throughput unchanged at 465k ops/s
`);

// Triage ruled this one to the spec, not the parser: a checkpoint task is ONE
// bullet, and SKILL.md rule 8 now says so. A task carries its own command and
// its own number on its own line. Teaching the parser to flatten a bullet tree
// into a toast string buys a shape nobody should write.
//
// So this pins the loss rather than the fix: a sub-bullet does not reach the
// human, and an author who writes one gets "Expect:" with nothing after it.
test("ADV-5 a task's sub-bullets are not carried (the spec says one bullet, one task)", () => {
  const cp = parseGuide(SUBBULLETS).checkpoints[0];
  assert.deepStrictEqual(cp.tasks, ["Run `cargo bench wal_append`. Expect:"]);
});

// ---------------------------------------------------------------------------
// 4. Two checkpoints keyed to one phase. The parser keeps both; every consumer
//    looks one up with `.find`, so the second is unreachable — and nothing
//    fails loud, which the canonical-guide invariant says it should.
// ---------------------------------------------------------------------------

const TWO_ON_ONE_PHASE = GUIDE(
  `- [ ] Run \`cargo test wal_replay_drops_tail\`. Expect 1 failure.
`,
  {
    tail: `### CHECKPOINT: also phase 1

- [ ] Run \`cargo clippy -p wal\`. Expect no new warnings.

`,
  },
);

// Fixed by failing loud. Every consumer resolves a phase to one checkpoint, so
// keeping both and showing the first is the silent data loss CLAUDE.md forbids.
// The throw names the phase, because that is what the author has to go and fix.
test("ADV-6 two checkpoints on one phase throw, naming the phase", () => {
  assert.throws(
    () => parseGuide(TWO_ON_ONE_PHASE),
    /two checkpoints under "Phase 1: Reproduction tests"/,
  );
});

// ---------------------------------------------------------------------------
// 5. A checkpoint with no phase above it is keyed "Steps". The tree only builds
//    a "Steps" group when some STEP has no phase (guideTree.ts:57), so in a
//    fully phased guide that checkpoint has no parent node and never renders.
// ---------------------------------------------------------------------------

const ORPHAN = `# Replay: t

## System Invariants

- **Inv A:** reason a.

### CHECKPOINT: before you start

- [ ] Confirm you are on a clean branch off the base commit.

## Phase 1: Reproduction tests

### Step 1.1: t

**File:** \`src/wal.rs\`
**Action:** Create
**Symbol:** \`t\`
**Why:** w.

**Retrospective:** none
`;

// Triage deleted this finding: a checkpoint closes a phase by construction, and
// nobody writes a preamble one. What survives is the key it lands on, because
// the runner and the tree both have to agree on the same literal or the lookup
// misses.
test("ADV-7 a phaseless checkpoint keys to the same literal the tree falls back to", () => {
  const g = parseGuide(ORPHAN);
  assert.strictEqual(g.checkpoints.length, 1);
  assert.strictEqual(g.checkpoints[0].phase, "Steps");
});

// ---------------------------------------------------------------------------
// 6. `- [x]` is accepted by TASK (guide.ts:94) and then counted as outstanding:
//    extension.ts:250 renders `checkpoint: ${pending} to run`, guideTree.ts:129
//    gives every task a `circle-outline`. A guide author who ticks a box is told
//    to run it anyway.
// ---------------------------------------------------------------------------

const TICKED = GUIDE(`- [x] Baseline bench recorded before the change (the author already did this).
- [ ] Run \`cargo test wal_replay_drops_tail\`. Expect 1 failure.
`);

test("ADV-8 a ticked `- [x]` item is not counted as something to run", () => {
  const cp = parseGuide(TICKED).checkpoints[0];
  const pending = cp.tasks.length; // extension.ts:249
  assert.strictEqual(pending, 1, `status bar would say "checkpoint: ${pending} to run"`);
});

// ---------------------------------------------------------------------------
// Checked and clean. These pass.
// ---------------------------------------------------------------------------

test("ADV-9 (no defect) CRLF parses the same tasks as LF", () => {
  const lf = parseGuide(SUBBULLETS).checkpoints[0].tasks;
  const crlf = parseGuide(SUBBULLETS.replace(/\n/g, "\r\n")).checkpoints[0].tasks;
  assert.deepStrictEqual(crlf, lf);
  assert.ok(!crlf.some((t) => /\r/.test(t)), "no carriage returns in a task");
});

test("ADV-10 (no defect) a checkpoint's bare `> **Answer:**` does not throw the step gate's count check", () => {
  const md = GUIDE(`**Understanding check:**

- What does the tail record prove that a length check does not?
  > **Answer:** that the writer acked bytes the reader cannot see.

- [ ] Run \`cargo test\`. Expect 1 failure.
`);
  const cp = parseGuide(md).checkpoints[0];
  assert.deepStrictEqual(cp.tasks, ["Run `cargo test`. Expect 1 failure."]);
});

test("ADV-11 (no defect) a checkpoint never swallows the next phase's steps", () => {
  const g = parseGuide(FENCED);
  assert.deepStrictEqual(g.steps.map((s) => s.id), ["1.1", "2.1"]);
  assert.strictEqual(g.steps[1].phase, "Phase 2: The fix");
});

// ---------------------------------------------------------------------------
// The surface contract. `humanReplay.guide.openCheckpoint` is registered in
// extension.ts:475 and contributed nowhere; its two siblings are both in
// package.json and both pinned by surface.test.cjs. A rename breaks every
// checkpoint and task node's click with no test to catch it.
// ---------------------------------------------------------------------------

// Triage deleted this finding and the inverse is the real contract: the command
// takes a line number from the tree node, so a Command Palette entry for it
// would be an entry that does nothing when a human picks it. Registered, never
// contributed, on purpose.
test("ADV-12 openCheckpoint is registered and deliberately not in the palette", () => {
  const root = path.join(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const declared = (pkg.contributes.commands || []).map((c) => c.command);
  const registered = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
  assert.ok(registered.includes('registerCommand("humanReplay.guide.openCheckpoint"'), "registered");
  assert.ok(
    !declared.includes("humanReplay.guide.openCheckpoint"),
    "a palette entry would hand the human a command that needs an argument they cannot give",
  );
});
