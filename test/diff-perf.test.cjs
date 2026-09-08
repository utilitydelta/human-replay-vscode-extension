// The tree diff's cost, measured rather than assumed.
//
// `buildReplaySteps` runs once when a modify step opens, on the extension host's
// only thread. The LCS that anchors the two symbol trees is O(m*n) in the node
// counts, which is fine — what was not fine was allocating a substring per DP
// cell: a 2000-statement symbol took 2.1 seconds to diff a ONE-LINE change, and
// the human meets that as the editor freezing when the step opens. The node
// texts are sliced once now.
//
// The budget below is deliberately loose (a loaded machine running the rest of
// this suite in parallel must not go red on timing alone), and it is still an
// order of magnitude under the behaviour it guards. Byte-exactness is asserted
// alongside every measurement: the diff must not buy speed with correctness.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

// The bundle lives beside the other oracles: it requires the native
// `tree-sitter` grammars at run time, so it has to resolve from this repo.
const bundle = path.join(__dirname, ".diff-perf.bundle.cjs");
const entry = path.join(__dirname, ".diff-perf.entry.ts");
fs.writeFileSync(
  entry,
  `export { diffSymbols, parseRoot } from "../src/disclosure/diff";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n` +
    `export { resolveStep } from "../src/disclosure/replay";\n` +
    `export { RUST } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  platform: "node",
  format: "cjs",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { diffSymbols, parseRoot, buildReplaySteps, resolveStep, RUST } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

// A symbol with `n` sibling statements — the shape that makes the LCS wide.
function bigSymbol(n) {
  const body = Array.from({ length: n }, (_, i) => `    total += values[${i}] * ${i % 7};`).join("\n");
  return `pub fn big(values: &[i64]) -> i64 {\n    let mut total = 0;\n${body}\n    total\n}`;
}

// Loose enough to survive a loaded runner, tight enough to catch the
// substring-per-cell regression, which was 2100ms at this size.
const BUDGET_MS = 900;

test("a one-line change in a 2000-statement symbol diffs promptly and byte-exact", () => {
  const before = bigSymbol(2000);
  const after = before.replace("values[1000] * 6;", "values[1000] * 9;");
  assert.notStrictEqual(after, before, "the corpus edit must apply");

  const started = Date.now();
  const steps = buildReplaySteps(before, after, RUST);
  const elapsed = Date.now() - started;

  assert.strictEqual(steps.length, 1, "one changed statement is one op, not a block replace");
  assert.ok(elapsed < BUDGET_MS, `diffing 60KB for a one-line change took ${elapsed}ms (budget ${BUDGET_MS}ms)`);

  const r = resolveStep(before, parseRoot(before, RUST), steps[0], 0, []);
  assert.ok(r, "the op must resolve");
  assert.strictEqual(before.slice(0, r[0]) + steps[0].replacement + before.slice(r[1]), after, "byte-exact");
});

test("the diff's cost grows with the node count, not with a substring per cell", () => {
  // Doubling the statements quadruples the DP cells, so the honest expectation
  // is roughly 4x. The regression this guards multiplied that by the cost of an
  // allocation per cell, which showed up as a much steeper curve; anything near
  // 8x per doubling is that shape coming back.
  const time = (n) => {
    const before = bigSymbol(n);
    const after = before.replace(`values[${n / 2}] * ${(n / 2) % 7};`, `values[${n / 2}] * 9;`);
    assert.notStrictEqual(after, before, `the edit must apply at n=${n}`);
    const started = Date.now();
    const { ops } = diffSymbols(before, after, RUST);
    assert.strictEqual(ops.length, 1, `n=${n} must stay a single op`);
    return Date.now() - started;
  };
  const small = Math.max(1, time(500));
  const large = time(2000);
  assert.ok(
    large < small * 40,
    `16x the DP cells cost ${(large / small).toFixed(1)}x the time (${small}ms -> ${large}ms) — the per-cell allocation is back`,
  );
});
