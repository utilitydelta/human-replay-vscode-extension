// Unit tests for live re-anchored replay (src/disclosure/replay.ts).
//
// The point of re-anchoring over baked offsets: an op still lands on the right
// node after the human's edits shift the bytes around it. So two invariants —
// (1) on the un-diverged buffer, anchor resolution reproduces the diff exactly;
// (2) after a benign divergence in a *stable* region, the same ops re-resolve and
// still produce the intended result. (2) is what a precomputed-offset replay
// cannot do; it is the reason this module exists.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

// --- load the real engine (diff + replay, one bundle) ----------------------
const bundle = path.join(__dirname, ".replay.bundle.cjs");
fs.writeFileSync(
  path.join(__dirname, ".replay.entry.ts"),
  `export { diffSymbols } from "../src/disclosure/diff";\nexport { replayLive } from "../src/disclosure/replay";\n`,
);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, ".replay.entry.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { diffSymbols, replayLive } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(path.join(__dirname, ".replay.entry.ts"), { force: true });
});

// --- corpus: (old, new) plus a benign divergence in a stable region --------
// `perturb` is applied (first-occurrence string replace) to BOTH old and new,
// simulating a hand-edit the human made to code neither side's diff touches. The
// ops are computed from the ORIGINAL pair, then replayed onto the perturbed old.
const CORPUS = [
  {
    name: "add (appended)",
    old: `fn run() {\n    let a = 1;\n    let b = 2;\n}\n`,
    new: `fn run() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n}\n`,
    perturb: ["let a = 1;", "let alpha = 111;"],
  },
  {
    name: "delete (middle)",
    old: `fn run() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n}\n`,
    new: `fn run() {\n    let a = 1;\n    let c = 3;\n}\n`,
    perturb: ["let a = 1;", "let alpha = 111;"],
  },
  {
    name: "modify-body",
    old: `fn run() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n}\n`,
    new: `fn run() {\n    let a = 1;\n    let b = 20;\n    let c = 3;\n}\n`,
    perturb: ["let a = 1;", "let alpha = 111;"],
  },
  {
    name: "modify-signature",
    old: `fn pick(x: i32) -> i32 {\n    let y = x;\n    y\n}\n`,
    new: `fn pick(x: i32) -> i64 {\n    let y = x;\n    y\n}\n`,
    perturb: ["let y = x;", "let yy = x + 0;"],
  },
  {
    name: "nested-modify (operator deep in for/if)",
    old: `fn must_fence(now: u64) -> bool {\n    let mut hit = false;\n    for peer in peers {\n        if peer.expiry < now {\n            hit = true;\n        }\n    }\n    hit\n}\n`,
    new: `fn must_fence(now: u64) -> bool {\n    let mut hit = false;\n    for peer in peers {\n        if peer.expiry <= now {\n            hit = true;\n        }\n    }\n    hit\n}\n`,
    perturb: ["let mut hit = false;", "let mut hit = Default::default();"],
  },
  {
    name: "mixed",
    old: `fn run() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n}\n`,
    new: `fn run() {\n    let a = 1;\n    let b = 22;\n    let d = 4;\n}\n`,
    perturb: ["let a = 1;", "let alpha = 111;"],
  },
];

const once = (s, find, repl) => {
  const i = s.indexOf(find);
  assert.notStrictEqual(i, -1, `perturb target ${JSON.stringify(find)} must exist`);
  return s.slice(0, i) + repl + s.slice(i + find.length);
};

// --- invariants ------------------------------------------------------------

for (const { name, old: oSrc, new: nSrc, perturb } of CORPUS) {
  test(`${name}: re-anchored replay on the un-diverged buffer reproduces the diff`, () => {
    const { ops } = diffSymbols(oSrc, nSrc);
    assert.strictEqual(replayLive(oSrc, ops), nSrc);
  });

  test(`${name}: ops survive a benign divergence in a stable region (re-anchor)`, () => {
    const { ops } = diffSymbols(oSrc, nSrc);
    const divergedOld = once(oSrc, perturb[0], perturb[1]);
    const divergedNew = once(nSrc, perturb[0], perturb[1]);
    // Sanity: the perturbation must land in a region the diff left untouched —
    // otherwise the test is not exercising re-anchoring over a stable sibling.
    assert.notStrictEqual(divergedOld, oSrc, "perturbation must change old");
    assert.strictEqual(
      replayLive(divergedOld, ops),
      divergedNew,
      "re-anchored ops must rebuild the diverged new byte-exact",
    );
  });
}
