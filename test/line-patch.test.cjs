// Oracles for the Patch step's line-grain engine (src/disclosure/lineDiff.ts +
// the parse-free resolver).
//
// A Patch step lands a file's residual delta — the bits below symbol grain the
// structural engine can't address: import edits, module doc headers, top-level
// items whose home is a convention, files with no grammar at all. These pin the
// invariant pair the surface leans on:
//   - every hunk's originalText is a byte-exact slice of the old file and every
//     replacement a byte-exact slice of the new (nothing synthesized);
//   - replaying the hunks through the sequential parse-free policy
//     (resolveStepNoTree + selfDelta) rebuilds the new file byte-exact —
//     including CRLF files and the pathological whole-block fallback.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".line-patch.bundle.cjs");
const entry = path.join(__dirname, ".line-patch.entry.ts");
fs.writeFileSync(
  entry,
  `export { lineDiffSteps, patchSummary } from "../src/disclosure/lineDiff";\n` +
    `export { resolveStepNoTree } from "../src/disclosure/replay";\n` +
    `export { parseGuide } from "../src/disclosure/guide";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { lineDiffSteps, patchSummary, resolveStepNoTree, parseGuide } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

// The runner's exact sequential policy for a patch session.
function replayHunks(oldText, steps) {
  let buf = oldText;
  let selfDelta = 0;
  for (const h of steps) {
    const r = resolveStepNoTree(buf, h, selfDelta);
    assert.ok(r, "every hunk must resolve (null = collision modal)");
    buf = buf.slice(0, r[0]) + h.replacement + buf.slice(r[1]);
    selfDelta += h.replacement.length - (r[1] - r[0]);
  }
  return buf;
}

// The real manual-bit shapes the Patch step exists for.
const CASES = [
  {
    name: "import edit + const (the 44-file integration-test shape)",
    old: `use std::time::Duration;\n\nuse crate::{count_events, is_leader, write_event, TestServer};\n\nmod tests;\n\nfn run() {}\n`,
    new: `use std::time::Duration;\n\nuse crate::{count_events, is_leader, poll_event_count_eq, write_event, TestServer};\n\nconst CONVERGE_TIMEOUT: Duration = Duration::from_secs(30);\n\nmod tests;\n\nfn run() {}\n`,
  },
  {
    name: "module doc header rewrite (unanchored trivia)",
    old: `//! Old story about immediate reads.\n//! Second line.\n\nuse a::b;\n\nfn t() {}\n`,
    new: `//! New story: the follower polls to the leader's count first.\n//! Convergence is guaranteed; a flake is a bug.\n\nuse a::b;\n\nfn t() {}\n`,
  },
  {
    name: "enum lands after the imports, not end-of-file (placement by bytes)",
    old: `use x::y;\nuse x::z;\n\npub fn sync() {}\n`,
    new: `use x::y;\nuse x::z;\n\npub(crate) enum CommitTarget {\n    Immediate,\n    DeferLeader,\n    DeferFollower,\n}\n\npub fn sync() {}\n`,
  },
  {
    name: "shell block (no grammar, fails closed everywhere else)",
    old: `#!/bin/bash\nset -e\necho ">>> apt update"\nsudo apt update -qq\necho done\n`,
    new: `#!/bin/bash\nset -e\necho ">>> apt update"\nsudo apt update -qq\necho ">>> Installing chrony..."\nsudo apt install -y -qq chrony\necho done\n`,
  },
  {
    name: "CRLF file keeps its endings byte-exact",
    old: `line one\r\nline two\r\nline three\r\n`,
    new: `line one\r\nline two changed\r\ninserted\r\nline three\r\n`,
  },
  {
    name: "delete-only hunk",
    old: `a\nstale line\nb\n`,
    new: `a\nb\n`,
  },
  {
    name: "no trailing newline on the last line",
    old: `a\nb`,
    new: `a\nc`,
  },
];

for (const c of CASES) {
  test(`patch hunks replay byte-exact — ${c.name}`, () => {
    const steps = lineDiffSteps(c.old, c.new);
    assert.ok(steps.length >= 1, "a real delta must produce hunks");
    for (const s of steps) {
      assert.strictEqual(c.old.slice(s.start, s.end), s.originalText, "originalText is a byte-exact old slice");
      assert.ok(s.replacement === "" || c.new.includes(s.replacement), "replacement is real new bytes");
    }
    assert.strictEqual(replayHunks(c.old, steps), c.new);
  });
}

test("identical files produce zero hunks", () => {
  assert.deepStrictEqual(lineDiffSteps("a\nb\n", "a\nb\n"), []);
});

test("pathological middle falls back to one block swap — still byte-exact", () => {
  // Middles beyond the DP budget must not silently drop bytes.
  const oldLines = [], newLines = [];
  for (let i = 0; i < 1200; i++) {
    oldLines.push(`old line ${i}`);
    newLines.push(`new line ${i}`);
  }
  const oldText = "frame top\n" + oldLines.join("\n") + "\nframe bottom\n";
  const newText = "frame top\n" + newLines.join("\n") + "\nframe bottom\n";
  const steps = lineDiffSteps(oldText, newText);
  assert.strictEqual(steps.length, 1, "over-budget middle collapses to one block");
  assert.strictEqual(replayHunks(oldText, steps), newText);
});

// The pause summary the runner shows before arming a patch: hunk count plus the
// live lines those hunks strike. Hand-pinned shapes — an insert strikes nothing,
// a replace strikes what it swaps out, a delete strikes what it removes — so the
// warning the human ratifies can never claim more or less than Tab would do.
const SUMMARY_CASES = [
  { name: "identical files: nothing to reconcile", old: "a\nb\n", new: "a\nb\n", hunks: 0, struckLines: 0 },
  { name: "pure insert strikes no live lines", old: "a\nc\n", new: "a\nb\nc\n", hunks: 1, struckLines: 0 },
  { name: "one-line replace strikes one", old: "a\nb\nc\n", new: "a\nX\nc\n", hunks: 1, struckLines: 1 },
  { name: "two-line delete strikes two", old: "a\nb\nc\nd\n", new: "a\nd\n", hunks: 1, struckLines: 2 },
  { name: "replace + delete tally independently", old: "a\nb\nc\nd\ne\n", new: "a\nX\nc\ne\n", hunks: 2, struckLines: 2 },
];

for (const c of SUMMARY_CASES) {
  test(`patch summary counts what Tab would strike — ${c.name}`, () => {
    assert.deepStrictEqual(patchSummary(c.old, c.new), { hunks: c.hunks, struckLines: c.struckLines });
  });
}

test("guide parser: a Patch step parses with File only, symbol defaults to the file", () => {
  const g = parseGuide(
    `# Replay: t\n\n## System Invariants\n\n- **Inv A:** reason a.\n\n` +
      `### Step 9.9: converge the file\n\n**File:** \`deploy/setup-nodes.sh\`\n**Action:** Patch\n\n**Why:** manual bits ride the replay now.\n`,
  );
  assert.strictEqual(g.steps[0].action, "patch");
  assert.strictEqual(g.steps[0].symbol, "deploy/setup-nodes.sh");
});
