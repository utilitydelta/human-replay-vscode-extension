// Unit tests for the surgical-vs-rewrite classifier (src/disclosure/strategy.ts).
//
// The cutover decision keys off two AST signals — control-flow skeleton change and
// survival ratio. These pin the decision at the boundaries that matter: a leaf
// tweak patches, a restructure rewrites, and a function whose skeleton holds but
// whose every leaf changed rewrites on survival alone.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".strategy.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/strategy.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust"],
});
const { classifyReplay } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

const FENCE_OLD = `fn must_fence(&self, now: Timestamp) -> bool {\n    for peer in &self.peers {\n        if peer.lease_expiry < now {\n            return true;\n        }\n    }\n    false\n}`;

const CASES = [
  {
    name: "leaf tweak (asymmetric grace) → surgical",
    old: FENCE_OLD,
    new: FENCE_OLD.replace("peer.lease_expiry < now", "peer.lease_expiry + LEASE_GRACE < now"),
    strategy: "surgical",
  },
  {
    name: "for/if collapsed to an iterator chain → rewrite (skeleton changed)",
    old: FENCE_OLD,
    new: `fn must_fence(&self, now: Timestamp) -> bool {\n    self.peers.iter().any(|peer| peer.lease_expiry + LEASE_GRACE < now)\n}`,
    strategy: "rewrite",
    skeletonChanged: true,
  },
  {
    name: "signature-only change, body intact → surgical (survival high, skeleton same)",
    old: FENCE_OLD,
    new: FENCE_OLD.replace("-> bool", "-> Result<bool, Error>"),
    strategy: "surgical",
    skeletonChanged: false,
  },
  {
    // The degree, not the boolean: one added branch moved ~1/4 of the skeleton,
    // below SKELETON_FLOOR, so it stays surgical. Pre-fraction this forced rewrite.
    name: "one added branch (structural but small) → surgical (skeleton change below floor)",
    old: FENCE_OLD,
    new: `fn must_fence(&self, now: Timestamp) -> bool {\n    for peer in &self.peers {\n        if peer.lease_expiry < now {\n            return true;\n        }\n        if peer.suspect_drift(now) {\n            return true;\n        }\n    }\n    false\n}`,
    strategy: "surgical",
    skeletonChanged: true,
  },
  {
    name: "skeleton holds but every leaf rewritten → rewrite (survival floor)",
    old: `fn step(n: i32) -> i32 {\n    let a = n + 1;\n    let b = a * 2;\n    let c = b - 3;\n    c\n}`,
    new: `fn step(n: i32) -> i32 {\n    let x = compute_first(n);\n    let y = transform(x, FACTOR);\n    let z = finalize(y);\n    z\n}`,
    strategy: "rewrite",
    skeletonChanged: false,
  },
];

for (const c of CASES) {
  test(`${c.name}`, () => {
    const plan = classifyReplay(c.old, c.new);
    assert.strictEqual(plan.strategy, c.strategy, `survival=${plan.survival.toFixed(2)} skeletonChanged=${plan.skeletonChanged} hunks=${plan.hunks}`);
    if (c.skeletonChanged !== undefined) assert.strictEqual(plan.skeletonChanged, c.skeletonChanged);
  });

  test(`${c.name}: survival is a fraction in [0,1]`, () => {
    const plan = classifyReplay(c.old, c.new);
    assert.ok(plan.survival >= 0 && plan.survival <= 1, `survival ${plan.survival} out of range`);
  });
}
