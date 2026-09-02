// Unit tests for replay-guide ingestion (src/disclosure/guide.ts).
//
// The guide is canonical (invariant 3) and self-contained: each step carries the
// real sandbox bytes (invariant 1). These oracles pin the parse — byte-exact
// before/after extraction, action parsing, invariant resolution by rule name,
// step ordering — and prove the parser fails loud on a malformed guide rather
// than silently dropping a step or inventing an invariant.
//
// The happy-path case parses the *shipped* guide (replay-guides/asymmetric-fencing.md),
// so the test guards the real artifact the extension loads, not a private copy.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".guide.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/guide.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
});
const { parseGuide } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

const SHIPPED = fs.readFileSync(
  path.join(__dirname, "../replay-guides/asymmetric-fencing.md"),
  "utf8",
);

// The bytes the guide must reproduce verbatim — ground truth (invariant 1).
const FENCE_OLD = `fn must_fence(&self, now: Timestamp) -> bool {\n    for peer in &self.peers {\n        if peer.lease_expiry < now {\n            return true;\n        }\n    }\n    false\n}`;
const FENCE_FIXED = `fn must_fence(&self, now: Timestamp) -> bool {\n    for peer in &self.peers {\n        if peer.lease_expiry + LEASE_GRACE < now {\n            return true;\n        }\n    }\n    false\n}`;
const FENCE_REWRITE = `fn must_fence(&self, now: Timestamp) -> bool {\n    self.peers\n        .iter()\n        .any(|peer| peer.lease_expiry + LEASE_GRACE < now)\n}`;

test("shipped guide: feature + system invariants parse", () => {
  const g = parseGuide(SHIPPED);
  assert.strictEqual(g.feature, "asymmetric-fencing");
  const rules = g.invariants.map((i) => i.rule).sort();
  assert.deepStrictEqual(rules, ["No two leaders", "Single writer"]);
});

test("shipped guide: steps parse in order with the right actions", () => {
  const g = parseGuide(SHIPPED);
  assert.strictEqual(g.steps.length, 2);
  assert.deepStrictEqual(
    g.steps.map((s) => s.id),
    ["1.1", "1.2"],
  );
  assert.ok(g.steps.every((s) => s.action === "modify"));
  assert.strictEqual(g.steps[0].symbol, "must_fence");
});

test("ground truth: before/after fences extract byte-exact", () => {
  const g = parseGuide(SHIPPED);
  assert.strictEqual(g.steps[0].before, FENCE_OLD);
  assert.strictEqual(g.steps[0].after, FENCE_FIXED);
  // Step 1.2 is the rewrite side of the cutover.
  assert.strictEqual(g.steps[1].before, FENCE_FIXED);
  assert.strictEqual(g.steps[1].after, FENCE_REWRITE);
});

test("invariants resolve from the declared set by rule name", () => {
  const g = parseGuide(SHIPPED);
  const step = g.steps[0];
  assert.deepStrictEqual(
    step.retro.invariants.map((i) => i.rule),
    ["Single writer", "No two leaders"],
  );
  // The reason rides along, not just the rule name.
  assert.match(step.retro.invariants[0].reason, /split-brain/);
  // Step 1.2 references only one of them.
  assert.deepStrictEqual(
    g.steps[1].retro.invariants.map((i) => i.rule),
    ["Single writer"],
  );
});

test("file is stripped of backticks so it resolves as a path", () => {
  const g = parseGuide(SHIPPED);
  for (const s of g.steps) {
    assert.ok(!s.file.includes("`"), `file "${s.file}" must not carry backticks`);
  }
  assert.strictEqual(g.steps[0].file, "src/raft/lease.rs:42");
});

test("each step captures the Phase heading it falls under", () => {
  const g = parseGuide(SHIPPED);
  assert.strictEqual(g.steps[0].phase, "Phase 1: Fencing fix");
  assert.strictEqual(g.steps[1].phase, "Phase 1: Fencing fix");
});

test("steps before any Phase heading have an undefined phase", () => {
  const g = parseGuide(
    MINIMAL(`### Step 1.1: x\n\n**Symbol:** \`f\`\n**Action:** Create\n\n**After:**\n\`\`\`\nfn f() {}\n\`\`\`\n`),
  );
  assert.strictEqual(g.steps[0].phase, undefined);
});

test("retrospective question is carried per step", () => {
  const g = parseGuide(SHIPPED);
  assert.match(g.steps[0].retro.question, /clock drifts past the TTL/);
  assert.strictEqual(g.steps[0].retro.symbol, "must_fence");
});

// --- Synthetic guides for the create/delete shapes and the failure paths. ---

const MINIMAL = (body) => `# Replay: t\n\n## System Invariants\n\n- **Inv A:** reason a.\n\n${body}\n`;

test("create step needs After, not Before", () => {
  const g = parseGuide(
    MINIMAL(
      `### Step 1.1: new fn\n\n**Symbol:** \`f\`\n**Action:** Create\n\n**After:**\n\`\`\`rust\nfn f() {}\n\`\`\`\n`,
    ),
  );
  assert.strictEqual(g.steps[0].action, "create");
  assert.strictEqual(g.steps[0].before, undefined);
  assert.strictEqual(g.steps[0].after, "fn f() {}");
});

test("delete step needs Before, not After", () => {
  const g = parseGuide(
    MINIMAL(
      `### Step 1.1: drop fn\n\n**Symbol:** \`f\`\n**Action:** Delete\n\n**Before:**\n\`\`\`rust\nfn f() {}\n\`\`\`\n`,
    ),
  );
  assert.strictEqual(g.steps[0].action, "delete");
  assert.strictEqual(g.steps[0].after, undefined);
});

test("lean step: a Modify with a File and no fences parses, bytes deferred to runtime", () => {
  // Option-2 guides carry no code; the runner resolves Before from the target and
  // After from the sandbox by symbol. The parser must accept this, not demand fences.
  const g = parseGuide(
    MINIMAL(
      `### Step 1.1: gate ack\n\n**Symbol:** \`confirmation_gate\`\n**File:** \`celeriant_shard/src/shard_wal_sync.rs\`\n**Action:** Modify\n**Why:** kill the false-ack race.\n`,
    ),
  );
  assert.strictEqual(g.steps[0].action, "modify");
  assert.strictEqual(g.steps[0].before, undefined, "before resolved at runtime, not parsed");
  assert.strictEqual(g.steps[0].after, undefined, "after resolved at runtime, not parsed");
  assert.strictEqual(g.steps[0].file, "celeriant_shard/src/shard_wal_sync.rs");
  assert.strictEqual(g.steps[0].symbol, "confirmation_gate");
});

test("create-file step: whole-file grain, symbol defaults to the file, no fences needed", () => {
  // A brand-new boilerplate file (a test, a fixture) replays as ONE step — the
  // runner drops the whole sandbox file; nobody tabs it out node by node.
  const g = parseGuide(
    MINIMAL(
      `### Step 1.1: drop the chaos test\n\n**File:** \`celeriant_chaos/tests/follower_commit.rs\`\n**Action:** Create File\n**Why:** boilerplate harness; read it, don't rebuild it.\n`,
    ),
  );
  assert.strictEqual(g.steps[0].action, "create-file");
  assert.strictEqual(g.steps[0].symbol, "celeriant_chaos/tests/follower_commit.rs", "symbol defaults to the file");
  assert.strictEqual(g.steps[0].before, undefined);
  assert.strictEqual(g.steps[0].after, undefined, "bytes come from the sandbox file at run time");
});

test("create-file step: an explicit Symbol label wins over the file default", () => {
  const g = parseGuide(
    MINIMAL(
      `### Step 1.1: drop the chaos test\n\n**Symbol:** \`follower-commit chaos harness\`\n**File:** \`celeriant_chaos/tests/follower_commit.rs\`\n**Action:** create-file\n`,
    ),
  );
  assert.strictEqual(g.steps[0].action, "create-file");
  assert.strictEqual(g.steps[0].symbol, "follower-commit chaos harness");
});

test("multi-line Why is captured whole across wrapped lines", () => {
  const g = parseGuide(
    MINIMAL(
      `### Step 1.1: x\n\n**Symbol:** \`f\`\n**Action:** Create\n**Why:** first line\nsecond line\nthird line\n\n**After:**\n\`\`\`rust\nfn f() {}\n\`\`\`\n`,
    ),
  );
  assert.strictEqual(g.steps[0].why, "first line second line third line");
});

const THROWS = [
  {
    name: "missing Replay heading",
    md: `## System Invariants\n\n### Step 1.1: x\n\n**Symbol:** \`f\`\n**Action:** Create\n**After:**\n\`\`\`\nfn f(){}\n\`\`\`\n`,
    re: /missing `# Replay/,
  },
  {
    name: "dangling invariant reference",
    md: MINIMAL(
      `### Step 1.1: x\n\n**Symbol:** \`f\`\n**Action:** Create\n**Invariants:** Bogus\n\n**After:**\n\`\`\`\nfn f(){}\n\`\`\`\n`,
    ),
    re: /unknown invariant "Bogus"/,
  },
  {
    name: "unknown action",
    md: MINIMAL(`### Step 1.1: x\n\n**Symbol:** \`f\`\n**Action:** Frobnicate\n`),
    re: /unknown or missing \*\*Action/,
  },
  {
    name: "modify with no fences and no File to resolve from",
    md: MINIMAL(`### Step 1.1: x\n\n**Symbol:** \`f\`\n**Action:** Modify\n`),
    re: /no Before\/After fence and no \*\*File/,
  },
  {
    name: "no steps at all",
    md: `# Replay: empty\n\n## System Invariants\n\n- **A:** b.\n`,
    re: /no `### Step/,
  },
  {
    name: "create-file with no File to read from",
    md: MINIMAL(`### Step 1.1: x\n\n**Action:** Create File\n**Why:** y.\n`),
    re: /no Before\/After fence and no \*\*File/,
  },
];

for (const c of THROWS) {
  test(`malformed guide throws: ${c.name}`, () => {
    assert.throws(() => parseGuide(c.md), c.re);
  });
}

// --- Retrospective choice blocks (gated recall) ---
//
// A step's **Retrospective:** question may be followed by a blockquote carrying one
// **Answer:** line and exactly two **Distractor:** lines. That triple is the only
// shape the runtime can gate a step behind, so any other count is a malformed guide
// and must fail loud naming the step (invariant 3), never silently half-gate.
// Guides written before the block existed carry no blockquote at all and must keep
// parsing ungated — every guide on disk stays loadable.

const PHASED = (body) =>
  `# Replay: t\n\n## System Invariants\n\n- **Inv A:** reason a.\n\n## Phase 1: p\n\n${body}\n`;

const QUESTION = "Why can `align_down` never overflow where `align_up` can?";
const ANSWER = "It only masks bits off, which never increases the value.";
const D1 = "Bitwise ops are exempt from debug overflow checks.";
const D2 = "It takes a `u32`, so the sum cannot reach `u64::MAX`.";

// A lean Modify step: File, no fences — the shape the parser already accepts.
const RETRO_STEP = ({
  id = "1.1",
  why = "masking down cannot carry.",
  question = QUESTION,
  tail = "",
} = {}) =>
  `### Step ${id}: align_down\n\n**File:** \`src/align.rs\`\n**Action:** Modify\n**Symbol:** \`align_down\`\n**Why:** ${why}\n\n**Retrospective:** ${question}\n${tail}`;

const QUOTE = `> **Answer:** ${ANSWER}\n> **Distractor:** ${D1}\n> **Distractor:** ${D2}\n`;

// The whole gating contract in one place: 3 choices, answer first, labels stripped.
function assertGated(retro, label) {
  assert.strictEqual(retro.choices.length, 3, `${label}: exactly 3 choices`);
  assert.deepStrictEqual(
    retro.choices.map((c) => c.text),
    [ANSWER, D1, D2],
    `${label}: answer first, then distractors in document order, labels stripped and trimmed`,
  );
  assert.deepStrictEqual(
    retro.choices.map((c) => c.correct),
    [true, false, false],
    `${label}: only the Answer line is correct`,
  );
}

test("gated step: an Answer plus two Distractors parse as 3 choices, answer first", () => {
  const g = parseGuide(PHASED(RETRO_STEP({ tail: `\n${QUOTE}` })));
  assertGated(g.steps[0].retro, "gated step");
  assert.strictEqual(g.steps[0].retro.question, QUESTION, "the question is untouched by the block");
});

test("ungated step: a Retrospective with no blockquote parses with empty choices", () => {
  const g = parseGuide(PHASED(RETRO_STEP()));
  assert.deepStrictEqual(g.steps[0].retro.choices, []);
  assert.strictEqual(g.steps[0].retro.question, QUESTION);
});

test("shipped guide gates every step, and its guide-level blockquote is nobody's choices", () => {
  // replay-guides/asymmetric-fencing.md opens with a `>` blurb under `# Replay:`.
  // It sits outside every step section, so no step may claim it: three choices
  // per step, all of them from that step's own answer key. The demo is the
  // artifact the extension ships, so it is also the proof that the shipped guide
  // exercises the gate rather than describing it.
  const g = parseGuide(SHIPPED);
  const blurb = SHIPPED.split("\n").find((l) => l.startsWith("> The path"));
  assert.ok(blurb, "the shipped guide no longer opens with its guide-level blockquote");
  for (const s of g.steps) {
    assert.strictEqual(s.retro.choices.length, 3, `step ${s.id} must gate`);
    assert.strictEqual(s.retro.choices.filter((c) => c.correct).length, 1, `step ${s.id} needs exactly one answer`);
    for (const c of s.retro.choices) {
      assert.ok(!blurb.includes(c.text), `step ${s.id} claimed the guide-level blockquote as a choice`);
    }
  }
});

const RETRO_THROWS = [
  {
    name: "one distractor",
    quote: `> **Answer:** ${ANSWER}\n> **Distractor:** ${D1}\n`,
  },
  {
    name: "three distractors",
    quote: `> **Answer:** ${ANSWER}\n> **Distractor:** ${D1}\n> **Distractor:** ${D2}\n> **Distractor:** And a third one.\n`,
  },
  {
    name: "distractors with no answer",
    quote: `> **Distractor:** ${D1}\n> **Distractor:** ${D2}\n`,
  },
];

for (const c of RETRO_THROWS) {
  test(`malformed retrospective block throws and names the offending step: ${c.name}`, () => {
    // A clean step 1.1 precedes it, so the message naming 1.2 proves the parser
    // points at the broken step rather than the file or the first step.
    const md = PHASED(
      `${RETRO_STEP({ id: "1.1", tail: `\n${QUOTE}` })}\n${RETRO_STEP({ id: "1.2", tail: `\n${c.quote}` })}`,
    );
    assert.throws(() => parseGuide(md), /1\.2/, `${c.name}: message must name step 1.2`);
  });
}

test("a blockquote with no blank line before it parses identically and does not pollute the question", () => {
  const spaced = parseGuide(PHASED(RETRO_STEP({ tail: `\n${QUOTE}` }))).steps[0].retro;
  const tight = parseGuide(PHASED(RETRO_STEP({ tail: QUOTE }))).steps[0].retro;
  assertGated(tight, "tight blockquote");
  assert.strictEqual(tight.question, spaced.question, "blank line or not, same question");
  assert.strictEqual(tight.question, QUESTION);
  assert.ok(
    !/Answer|Distractor|masks bits/.test(tight.question),
    "a `>` line terminates the field; it is not a wrapped continuation of the question",
  );
});

test("a `>` line carrying no label joins the previous choice instead of becoming a fourth", () => {
  const wrapped =
    `> **Answer:** It only masks bits off,\n> which never increases the value.\n` +
    `> **Distractor:** Bitwise ops are exempt\n> from debug overflow checks.\n` +
    `> **Distractor:** ${D2}\n`;
  const g = parseGuide(PHASED(RETRO_STEP({ tail: `\n${wrapped}` })));
  assertGated(g.steps[0].retro, "wrapped answer and wrapped distractor");
});

for (const q of ["none", "None — trivial rename", "NONE"]) {
  for (const [shape, tail] of [["bare", ""], ["with an answer block", `\n${QUOTE}`]]) {
    test(`a "none" retrospective parses without error: ${JSON.stringify(q)}, ${shape}`, () => {
      // Refusing to gate a "none" question is a runtime call, not a parse error.
      const g = parseGuide(PHASED(RETRO_STEP({ question: q, tail })));
      assert.strictEqual(g.steps[0].retro.question, q);
      if (tail) assertGated(g.steps[0].retro, `none question ${shape}`);
      else assert.deepStrictEqual(g.steps[0].retro.choices, []);
    });
  }
}

test("a weak question with an answer and two distractors parses: the parser does not judge weakness", () => {
  const weak = "Does this make sense?";
  const g = parseGuide(PHASED(RETRO_STEP({ question: weak, tail: `\n${QUOTE}` })));
  assert.strictEqual(g.steps[0].retro.question, weak);
  assertGated(g.steps[0].retro, "weak question");
});

test("blockquote scoping: one step's choices never leak into the next step", () => {
  const g = parseGuide(
    PHASED(
      `${RETRO_STEP({ id: "1.1", tail: `\n${QUOTE}` })}\n${RETRO_STEP({ id: "1.2", question: "Second question?" })}`,
    ),
  );
  assert.strictEqual(g.steps.length, 2);
  assertGated(g.steps[0].retro, "step 1.1");
  assert.strictEqual(g.steps[1].retro.question, "Second question?");
  assert.deepStrictEqual(g.steps[1].retro.choices, [], "step 1.2 declares no blockquote of its own");
});

test("blockquote scoping: the reader stops at the first non-`>` line and the fences still parse", () => {
  const step =
    `### Step 1.1: must_fence\n\n**File:** \`src/raft/lease.rs\`\n**Action:** Modify\n**Symbol:** \`must_fence\`\n**Why:** w.\n\n` +
    `**Retrospective:** ${QUESTION}\n\n${QUOTE}\n` +
    "**Before:**\n```rust\nfn f() { 1 }\n```\n\n**After:**\n```rust\nfn f() { 2 }\n```\n";
  const g = parseGuide(PHASED(step));
  assertGated(g.steps[0].retro, "blockquote followed by Before/After");
  assert.strictEqual(g.steps[0].before, "fn f() { 1 }");
  assert.strictEqual(g.steps[0].after, "fn f() { 2 }");
});

test("retro.why mirrors the step Why, wrapped lines joined the way the field is joined", () => {
  const g = parseGuide(
    PHASED(RETRO_STEP({ why: "first line\nsecond line\nthird line", tail: `\n${QUOTE}` })),
  );
  assert.strictEqual(g.steps[0].why, "first line second line third line");
  assert.strictEqual(g.steps[0].retro.why, g.steps[0].why);

  const shipped = parseGuide(SHIPPED);
  for (const s of shipped.steps) {
    assert.strictEqual(s.retro.why, s.why, `step ${s.id}: retro.why is the step Why`);
  }
  assert.match(shipped.steps[0].retro.why, /Symmetric fencing .* skewed clock/);
});

// Lines counted by hand in the column comments; step 1.1 sits on line 9, step 1.2 on 18.
const LINE_FIXTURE = [
  "# Replay: t", //             1
  "", //                        2
  "## System Invariants", //     3
  "", //                        4
  "- **Inv A:** reason a.", //   5
  "", //                        6
  "## Phase 1: p", //            7
  "", //                        8
  "### Step 1.1: first", //      9
  "", //                       10
  "**File:** `src/a.rs`", //   11
  "**Action:** Modify", //     12
  "**Symbol:** `f`", //        13
  "**Why:** w.", //            14
  "", //                       15
  "**Retrospective:** none", //16
  "", //                       17
  "### Step 1.2: second", //   18
  "", //                       19
  "**File:** `src/b.rs`", //   20
  "**Action:** Modify", //     21
  "**Symbol:** `g`", //        22
  "**Why:** w.", //            23
].join("\n");

test("step.line is the 1-based line number of the `### Step` heading", () => {
  const g = parseGuide(LINE_FIXTURE);
  assert.strictEqual(g.steps[0].line, 9);
  assert.strictEqual(g.steps[1].line, 18);
  // Guard the hand count itself, so a fixture edit fails here and not mysteriously above.
  const lines = LINE_FIXTURE.split("\n");
  assert.ok(lines[8].startsWith("### Step 1.1:"), "line 9 is the 1.1 heading");
  assert.ok(lines[17].startsWith("### Step 1.2:"), "line 18 is the 1.2 heading");
});

test("step.line locates the heading in the shipped guide", () => {
  const g = parseGuide(SHIPPED);
  const lines = SHIPPED.split("\n");
  for (const s of g.steps) {
    const idx = lines.findIndex((l) => l.startsWith(`### Step ${s.id}:`));
    assert.notStrictEqual(idx, -1, `no heading found for step ${s.id}`);
    assert.strictEqual(s.line, idx + 1, `step ${s.id} heading line`);
  }
});
