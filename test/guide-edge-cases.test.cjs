// The guide parser's edge cases — the spellings a real guide arrives in.
//
// `guide.test.cjs` proves the canonical guide parses. This proves the parser
// holds when the guide is not spelled the way the corpus happens to be:
//
//   - a guide saved with CRLF line endings (a Windows editor, a git checkout
//     with autocrlf). The fenced Before/After bytes are GROUND TRUTH — they are
//     the sandbox's bytes, and a stray carriage return in them is a byte the
//     human would land that the sandbox does not have;
//   - a fence that wraps another fence (a step whose After is itself a markdown
//     file containing a code block). Fences nest by length, so a ```` block
//     closes on ```` and not on the ``` inside it;
//   - a guide that is wrong. The guide is canonical (invariant 3), so a defect
//     is loud: it throws, naming the step, rather than replaying something
//     plausible.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".guide-edges.bundle.cjs");
const entry = path.join(__dirname, ".guide-edges.entry.ts");
fs.writeFileSync(entry, `export { parseGuide } from "../src/disclosure/guide";\n`);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { parseGuide } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const HEAD = [
  "# Replay: edge cases",
  "",
  "## System Invariants",
  "",
  "- **Ground truth:** every landed byte is a real sandbox byte.",
  "",
  "## Phase 1: the edges",
  "",
].join("\n");

// A step whose Before/After fences carry exactly these bytes.
const stepWithFences = (before, after) =>
  [
    "### Step 1.1: land the bytes",
    "",
    "**File:** `src/lib.rs`",
    "**Action:** modify",
    "**Symbol:** total",
    "**Why:** the cap is applied at the end of the fold.",
    "**Retrospective:** why is the cap applied last?",
    "**Invariants:** Ground truth",
    "",
    "**Before:**",
    "```rust",
    before,
    "```",
    "",
    "**After:**",
    "```rust",
    after,
    "```",
    "",
  ].join("\n");

// --- CRLF ------------------------------------------------------------------

test("CRLF guide: the fenced bytes carry no stray carriage return", () => {
  const lf = HEAD + stepWithFences("fn total() -> i64 {\n    0\n}", "fn total() -> i64 {\n    1\n}");
  const crlf = lf.replace(/\n/g, "\r\n");
  const guide = parseGuide(crlf);
  assert.strictEqual(guide.steps.length, 1, "the step parses under CRLF");
  const step = guide.steps[0];
  // The fence's bytes are the sandbox's bytes. Under CRLF the LINES are
  // CRLF-terminated, but the block must not gain a trailing CR the sandbox
  // never had: the fence line that closes the block is not part of the block.
  assert.ok(!step.before.endsWith("\r"), `Before ends with a stray CR: ${JSON.stringify(step.before)}`);
  assert.ok(!step.after.endsWith("\r"), `After ends with a stray CR: ${JSON.stringify(step.after)}`);
  assert.strictEqual(step.before, "fn total() -> i64 {\r\n    0\r\n}", "internal line endings are preserved verbatim");
  assert.strictEqual(step.after, "fn total() -> i64 {\r\n    1\r\n}");
});

test("CRLF guide: fields, invariants and the retrospective parse identically to LF", () => {
  const lf = HEAD + stepWithFences("a", "b");
  const crlf = lf.replace(/\n/g, "\r\n");
  const fromLf = parseGuide(lf);
  const fromCrlf = parseGuide(crlf);
  const shape = (g) => ({
    feature: g.feature,
    invariants: g.invariants,
    steps: g.steps.map((s) => ({ id: s.id, title: s.title, phase: s.phase, file: s.file, action: s.action, symbol: s.symbol, why: s.why })),
  });
  assert.deepStrictEqual(shape(fromCrlf), shape(fromLf), "only the fenced bytes differ between the two spellings");
});

// --- nested fences ----------------------------------------------------------

test("a ```` fence captures an inner ``` block whole", () => {
  const inner = ["# Doc", "", "```bash", "npm test", "```", "", "Done."].join("\n");
  const md = [
    HEAD,
    "### Step 1.1: land the doc",
    "",
    "**File:** `docs/readme.md`",
    "**Action:** modify",
    "**Symbol:** Doc",
    "**Why:** the doc explains the test command.",
    "**Retrospective:** why does the doc carry the command?",
    "**Invariants:** Ground truth",
    "",
    "**Before:**",
    "````markdown",
    "# Doc",
    "````",
    "",
    "**After:**",
    "````markdown",
    inner,
    "````",
    "",
  ].join("\n");
  const step = parseGuide(md).steps[0];
  assert.strictEqual(step.before, "# Doc", "the Before block closes on its own ```` fence");
  assert.strictEqual(step.after, inner, "the inner ``` block rides inside the After, byte for byte");
});

// --- fail loud --------------------------------------------------------------

const MALFORMED = [
  {
    name: "no `# Replay:` heading",
    md: "## System Invariants\n\n- **Ground truth:** bytes are real.\n",
    expect: /missing .*Replay/i,
  },
  {
    name: "a step referencing an invariant that was never declared",
    md: HEAD + stepWithFences("a", "b").replace("**Invariants:** Ground truth", "**Invariants:** No Such Rule"),
    expect: /No Such Rule|invariant/i,
  },
  {
    name: "an action the engine has no surface for",
    md: HEAD + stepWithFences("a", "b").replace("**Action:** modify", "**Action:** refactor"),
    expect: /action/i,
  },
  {
    // A fence-aware section split means an unclosed fence swallows the rest of
    // the guide. That must be loud: silently ending up with one truncated step
    // is how a human replays half a feature and never learns the other half
    // existed.
    name: "an unclosed fence swallowing the rest of the guide",
    md: HEAD +
      [
        "### Step 1.1: land the bytes",
        "",
        "**File:** `src/lib.rs`",
        "**Action:** modify",
        "**Symbol:** total",
        "**Why:** nothing.",
        "**Retrospective:** why?",
        "**Invariants:** Ground truth",
        "",
        "**After:**",
        "```rust",
        "fn total() {}",
        "",
        "### Step 1.2: the step that vanished",
        "",
      ].join("\n"),
    expect: /step|fence|bytes|Before|After/i,
  },
  {
    name: "a modify step with no bytes on either side",
    md: HEAD +
      [
        "### Step 1.1: land the bytes",
        "",
        "**Action:** modify",
        "**Symbol:** total",
        "**Why:** nothing.",
        "**Retrospective:** why?",
        "**Invariants:** Ground truth",
        "",
      ].join("\n"),
    expect: /file|before|after|bytes/i,
  },
];

for (const c of MALFORMED) {
  test(`malformed guide fails loud — ${c.name}`, () => {
    assert.throws(() => parseGuide(c.md), c.expect, "a malformed guide throws rather than replaying something plausible");
  });
}

// --- the File field's ctrl-click suffix --------------------------------------

test("File keeps its `:line` suffix for the human's ctrl-click, and the path still resolves", () => {
  const md = HEAD + stepWithFences("a", "b").replace("**File:** `src/lib.rs`", "**File:** `src/lib.rs:42`");
  const step = parseGuide(md).steps[0];
  assert.strictEqual(step.file, "src/lib.rs:42", "the suffix survives the parse — the panel links on it");
});
