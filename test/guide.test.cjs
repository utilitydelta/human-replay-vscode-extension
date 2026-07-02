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
