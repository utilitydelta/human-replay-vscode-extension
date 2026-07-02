// Unit tests for the tree diff (src/disclosure/diff.ts) — the edit-aware engine's
// foundation. Mirrors spike S9's oracle in the repo's node:test idiom: esbuild
// bundles the real source, the tests assert the diff invariants the diff-replay
// engine leans on. Parameterized over the operation corpus; each test names the
// invariant it proves.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

// --- load the real engine --------------------------------------------------
const bundle = path.join(__dirname, ".diff.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/diff.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { diffSymbols, applyRange } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

// --- corpus: synthetic (old, new) pairs, one per node-level operation -------
// `move` flags the reorder case, where a text-keyed diff cannot keep a relocated-
// but-identical sibling in place (the GumTree gap S9 measures rather than fakes).
const CORPUS = [
  {
    name: "add (∅-body → body)",
    old: `fn must_fence(now: u64) -> bool {\n}\n`,
    new: `fn must_fence(now: u64) -> bool {\n    let expired = now > 0;\n    expired\n}\n`,
  },
  {
    name: "add (statement appended among siblings)",
    old: `fn run() {\n    let a = 1;\n    let b = 2;\n}\n`,
    new: `fn run() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n}\n`,
  },
  {
    name: "delete (middle statement removed)",
    old: `fn run() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n}\n`,
    new: `fn run() {\n    let a = 1;\n    let c = 3;\n}\n`,
  },
  {
    name: "delete (whole fn removed from file)",
    old: `fn keep() {\n    let a = 1;\n}\n\nfn doomed() {\n    let b = 2;\n}\n`,
    new: `fn keep() {\n    let a = 1;\n}\n`,
  },
  {
    name: "modify-body (statement value changed)",
    old: `fn run() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n}\n`,
    new: `fn run() {\n    let a = 1;\n    let b = 20;\n    let c = 3;\n}\n`,
  },
  {
    name: "modify-signature (return type changed, body identical)",
    old: `fn pick(x: i32) -> i32 {\n    let y = x;\n    y\n}\n`,
    new: `fn pick(x: i32) -> i64 {\n    let y = x;\n    y\n}\n`,
  },
  {
    name: "nested-modify (operator deep in for/if; siblings stable)",
    old: `fn must_fence(now: u64) -> bool {\n    let mut hit = false;\n    for peer in peers {\n        if peer.expiry < now {\n            hit = true;\n        }\n    }\n    hit\n}\n`,
    new: `fn must_fence(now: u64) -> bool {\n    let mut hit = false;\n    for peer in peers {\n        if peer.expiry <= now {\n            hit = true;\n        }\n    }\n    hit\n}\n`,
  },
  {
    name: "reorder (outer two swapped; middle unmoved)",
    old: `fn run() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n}\n`,
    new: `fn run() {\n    let c = 3;\n    let b = 2;\n    let a = 1;\n}\n`,
    move: true,
  },
  {
    name: "mixed (add + delete + modify in one symbol)",
    old: `fn run() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n}\n`,
    new: `fn run() {\n    let a = 1;\n    let b = 22;\n    let d = 4;\n}\n`,
  },
  {
    // Regression: a changed signature sitting next to a changed body is a two-child
    // run at the function node. The old gate only recursed single-pair runs, so the
    // whole signature+body spliced as one op — survival ~0, every such symbol routed
    // to a full rewrite. The diff must recurse into both and leave the unchanged
    // statements between them stable.
    name: "modify-both (signature param added AND body changed; stable statements between)",
    old: `fn run(a: i32) {\n    let x = 1;\n    let y = 2;\n    let z = 3;\n    let w = 4;\n}\n`,
    new: `fn run(a: i32, b: i32) {\n    let x = 1;\n    let y = 20;\n    let z = 3;\n    let w = 4;\n}\n`,
    granular: true,
    minSurvival: 0.5,
  },
  {
    // Regression: a doc comment that GAINS a line above a changed fn makes the root
    // run unequal-length ([comment, fn] vs [comment, comment, fn]). Equal-length-only
    // recursion spliced the whole symbol → rewrite. Peeling same-type pairs off both
    // ends aligns the comment from the front and the fn from the back; only the added
    // comment line splices, so the symbol stays surgical.
    name: "comment-grew (doc comment 1→2 lines above a changed fn)",
    old: `/// Does the thing.\nfn run() {\n    let a = 1;\n    let b = 2;\n}\n`,
    new: `/// Does the thing, immediately.\n/// And notes a caveat.\nfn run() {\n    let a = 1;\n    let b = 20;\n}\n`,
    granular: true,
  },
];

const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

// --- invariants ------------------------------------------------------------

for (const pair of CORPUS) {
  const { name, old: oSrc, new: nSrc } = pair;

  test(`${name}: applying the edit script to old rebuilds new byte-exact`, () => {
    const { ops } = diffSymbols(oSrc, nSrc);
    assert.strictEqual(applyRange(oSrc, 0, oSrc.length, ops), nSrc);
  });

  test(`${name}: no invented tokens (inserts are real new bytes, deletes real old bytes)`, () => {
    const { ops } = diffSymbols(oSrc, nSrc);
    for (const op of ops) {
      if (op.replacement !== "")
        assert.ok(nSrc.includes(op.replacement), `inserted text must be a literal slice of new: ${JSON.stringify(op.replacement)}`);
      if (op.oldText !== "")
        assert.ok(oSrc.includes(op.oldText), `deleted text must be a literal slice of old: ${JSON.stringify(op.oldText)}`);
    }
  });

  test(`${name}: an anchored (unchanged) subtree is never touched by an op`, () => {
    const { ops, stable } = diffSymbols(oSrc, nSrc);
    for (const [a0, a1] of stable) {
      for (const op of ops) {
        if (op.kind === "insert") continue;
        assert.ok(!overlaps(a0, a1, op.start, op.end), `stable range [${a0},${a1}] must not be edited`);
      }
    }
  });

  test(`${name}: ${pair.move ? "the move-aware gap is reported" : "no relocation is mistaken for change"}`, () => {
    const { moved } = diffSymbols(oSrc, nSrc);
    if (pair.move) assert.ok(moved.length > 0, "reorder must report relocated siblings");
    else assert.strictEqual(moved.length, 0, "no spurious move gap expected");
  });

  if (pair.granular) {
    test(`${name}: stays granular — the diff never splices the whole symbol into one op`, () => {
      const { ops, stable } = diffSymbols(oSrc, nSrc);
      // The classifier routes to a full rewrite when one op swallows the symbol. The
      // defining invariant here: no single op spans most of it. (Survival is body-
      // size-dependent, so it's only asserted where the fixture sets minSurvival.)
      assert.ok(!ops.some((op) => op.end - op.start > oSrc.length * 0.7), "no single op may span most of the symbol");
      if (pair.minSurvival !== undefined) {
        const stableBytes = stable.reduce((s, [a, b]) => s + (b - a), 0);
        assert.ok(
          stableBytes / oSrc.length > pair.minSurvival,
          `survival ${(stableBytes / oSrc.length).toFixed(3)} must clear ${pair.minSurvival}`,
        );
      }
    });
  }
}
