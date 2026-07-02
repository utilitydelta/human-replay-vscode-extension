// Unit tests for the disclosure walk engine (src/disclosure/walk.ts).
//
// The engine is pure (no vscode), so it is tested headless: esbuild bundles the
// real source once, the tests replay the steps exactly as the provider would and
// assert the invariants the rest of the system leans on. Parameterized over a
// corpus of Rust shapes; each test names the invariant it proves.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");
const Parser = require("tree-sitter");
const Rust = require("tree-sitter-rust");

// --- load the real engine --------------------------------------------------
const bundle = path.join(__dirname, ".walk.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/walk.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust"],
});
const { computeSteps, findItemByName, leadingTriviaStart } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

const parser = new Parser();
parser.setLanguage(Rust);

// --- corpus: bare functions at indent 0 (the engine's input contract) ------
const CORPUS = [
  { name: "no-nesting", code: `fn add(a: i32, b: i32) -> i32 {\n    a + b\n}` },
  {
    name: "single-for",
    code: `fn sum(xs: &[i32]) -> i32 {\n    let mut total = 0;\n    for x in xs {\n        total += x;\n    }\n    total\n}`,
  },
  {
    name: "fencing (if-in-for)",
    code: `fn must_fence(&self, now: Timestamp) -> bool {\n    for peer in &self.peers {\n        if peer.lease_expiry < now {\n            return true;\n        }\n    }\n    false\n}`,
  },
  {
    name: "nested-fn",
    code: `fn outer(n: u32) -> u32 {\n    fn helper(k: u32) -> u32 {\n        k + 1\n    }\n    helper(n)\n}`,
  },
  {
    name: "deep-nest (for>if>for)",
    code: `fn grid(rows: usize, cols: usize) -> usize {\n    let mut c = 0;\n    for r in 0..rows {\n        if r % 2 == 0 {\n            for _ in 0..cols {\n                c += 1;\n            }\n        }\n    }\n    c\n}`,
  },
  {
    name: "early-returns",
    code: `fn check(x: i32) -> Result<i32, Error> {\n    if x < 0 {\n        return Err(Error::Negative);\n    }\n    let doubled = x * 2;\n    Ok(doubled)\n}`,
  },
  {
    name: "if-else (revealed whole)",
    code: `fn sign(x: i32) -> i32 {\n    if x < 0 {\n        -1\n    } else {\n        1\n    }\n}`,
  },
  {
    name: "match (revealed whole)",
    code: `fn classify(s: State) -> Kind {\n    match s {\n        State::Leader => Kind::Writer,\n        State::Follower => Kind::Reader,\n    }\n}`,
  },
];

// --- helpers ---------------------------------------------------------------

// Replay the provider's contract: insert at cursor, then move cursor to
// cursorOffset. Returns a snapshot (buffer + cursor + kind) after each step.
function replay(steps) {
  let buf = "";
  let cur = 0;
  const snaps = [];
  for (const s of steps) {
    buf = buf.slice(0, cur) + s.insert + buf.slice(cur);
    cur = s.cursorOffset;
    snaps.push({ buf, cur, kind: s.kind });
  }
  return snaps;
}

function tokens(src) {
  const out = [];
  const cursor = parser.parse(src).walk();
  (function visit() {
    if (cursor.currentNode.childCount === 0) {
      const t = src.slice(cursor.currentNode.startIndex, cursor.currentNode.endIndex);
      if (t.trim()) out.push(t);
    }
    if (cursor.gotoFirstChild()) {
      do visit();
      while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  })();
  return out;
}

function isSubseq(a, b) {
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) if (a[i] === b[j]) i++;
  return i === a.length;
}

// Does any block node's braces strictly contain `offset`?
function insideABlock(src, offset) {
  let found = false;
  (function visit(n) {
    if (n.type === "block" && n.startIndex < offset && offset < n.endIndex - 1) found = true;
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i));
  })(parser.parse(src).rootNode);
  return found;
}

// --- invariants ------------------------------------------------------------

for (const { name, code } of CORPUS) {
  test(`${name}: full replay rebuilds the symbol byte-exact and parses clean`, () => {
    const final = replay(computeSteps(code)).at(-1).buf;
    assert.strictEqual(final, code, "final buffer must equal the original source");
    assert.ok(!parser.parse(final).rootNode.hasError, "final buffer must parse clean");
  });

  test(`${name}: every landed token is a real source token (ground-truth guarantee)`, () => {
    const final = replay(computeSteps(code)).at(-1).buf;
    assert.ok(
      isSubseq(tokens(code), tokens(final)),
      "original tokens must appear, in order, in the final buffer",
    );
  });

  test(`${name}: container cursors land inside the just-opened braces`, () => {
    const snaps = replay(computeSteps(code));
    for (let i = 0; i < snaps.length; i++) {
      if (snaps[i].kind !== "container") continue;
      assert.ok(
        insideABlock(snaps[i].buf, snaps[i].cur),
        `container step ${i} cursor must be inside a block`,
      );
    }
  });

  test(`${name}: each step's buffer is a subsequence of the next (monotonic)`, () => {
    const snaps = replay(computeSteps(code));
    for (let i = 0; i + 1 < snaps.length; i++) {
      assert.ok(
        isSubseq(snaps[i].buf, snaps[i + 1].buf),
        `step ${i} buffer must be a subsequence of step ${i + 1}`,
      );
    }
  });

  test(`${name}: insertOffset equals the previous step's cursorOffset (gate relies on it)`, () => {
    const steps = computeSteps(code);
    assert.strictEqual(steps[0].insertOffset, 0, "first step inserts at region offset 0");
    for (let i = 1; i < steps.length; i++) {
      assert.strictEqual(
        steps[i].insertOffset,
        steps[i - 1].cursorOffset,
        `step ${i} insertOffset must match step ${i - 1} cursorOffset`,
      );
    }
    const last = steps.at(-1);
    assert.strictEqual(
      last.cursorOffset,
      last.insertOffset + last.insert.length,
      "last step's cursor rests at the end of its own insert",
    );
  });
}

// --- leadingTriviaStart: the symbol owns its doc comments & attributes -------
// tree-sitter-rust models /// // and #[...] above an item as PRECEDING SIBLINGS,
// so the item node excludes them. The resolver must extend the start back over the
// attached block (no blank line) so a comment-only rewrite is diffed, and stop at a
// blank line or code so it never swallows an unrelated comment or the prior item.
const TRIVIA = [
  {
    name: "single doc-comment line",
    src: `mod m {\n    /// Does the thing.\n    fn go() {}\n}`,
    item: "go",
    expectFrom: "/// Does the thing.",
  },
  {
    name: "multi-line doc comment + attribute",
    src: `/// Line one.\n/// Line two.\n#[inline]\nfn go() {}`,
    item: "go",
    expectFrom: "/// Line one.",
  },
  {
    name: "blank line detaches the comment (not absorbed)",
    src: `// unrelated banner\n\nfn go() {}`,
    item: "go",
    expectFrom: "fn go()",
  },
  {
    name: "no comment — start unchanged",
    src: `fn go() {}`,
    item: "go",
    expectFrom: "fn go()",
  },
];

for (const { name, src, item, expectFrom } of TRIVIA) {
  test(`leadingTriviaStart: ${name}`, () => {
    const root = parser.parse(src).rootNode;
    const node = findItemByName(root, src, item);
    assert.ok(node, `fixture must contain item ${item}`);
    const start = leadingTriviaStart(src, node.startIndex);
    // The start lands at the line's beginning (indentation included, consistently on
    // both before/after); compare from the first non-space so indent doesn't matter.
    assert.ok(
      src.slice(start).trimStart().startsWith(expectFrom),
      `expected the symbol to begin at ${JSON.stringify(expectFrom)}, got ${JSON.stringify(src.slice(start, start + 28))}`,
    );
  });
}
