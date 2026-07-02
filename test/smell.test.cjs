// Unit tests for the weak-question smell (src/retrospective/retrospective.ts).
//
// The heuristic flags generic retrospective questions (the agent could not say
// why its code existed) and passes specific ones. Ported labelled set from spike
// S8, which hit precision/recall 1.00. The bar here is the same: no false alarm
// (a good question flagged weak) and no miss (a weak question passed).
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".smell.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/retrospective/retrospective.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
});
const { isWeak } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

// [question, isWeak] — weak = generic smell.
const CORPUS = [
  ["Does this make sense?", true],
  ["Are there any edge cases?", true],
  ["Is this performant?", true],
  ["Does this code work?", true],
  ["Any improvements?", true],
  ["Is this correct?", true],
  ["Anything wrong here?", true],
  ["Does this look good?", true],
  ["Is this the right approach?", true],
  ["Any issues with this?", true],
  ["What happens to `UserSession` if the token expires mid-request?", false],
  ["Why store the cache in a `HashMap` instead of `BTreeMap`?", false],
  ["This endpoint accepts untrusted input. What validation is missing?", false],
  ["Will this query use an index, or will it table scan?", false],
  ["What happens to the lease if the clock drifts past the TTL before the follower checks?", false],
  ["Why does `must_fence` use an asymmetric threshold instead of comparing to its own clock?", false],
  ["If the WAL catchup falls behind, does `too_far_behind` ever return early?", false],
  ["What happens when the peer queue is empty during fencing?", false],
];

test("every weak question is flagged (no miss)", () => {
  for (const [q, weak] of CORPUS) {
    if (weak) assert.strictEqual(isWeak(q), true, `should flag: "${q}"`);
  }
});

test("every specific question passes (no false alarm)", () => {
  for (const [q, weak] of CORPUS) {
    if (!weak) assert.strictEqual(isWeak(q), false, `should pass: "${q}"`);
  }
});
