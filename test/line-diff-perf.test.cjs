// Implementer regression test for the Hirschberg ceiling (adversarial finding:
// an enormous mostly-distinct middle used to run a multi-second O(m*n) sweep on
// the UI thread). Proves: above the ceiling the aligner returns a coarse block
// replace promptly instead of freezing; a realistically-sized scattered patch
// still stays granular. Byte-exactness is asserted throughout — the ceiling must
// never trade correctness for speed.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(os.tmpdir(), `linediff-perf-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/lineDiff.ts")],
  bundle: true,
  outfile: bundle,
  platform: "node",
  format: "cjs",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { lineDiffSteps } = require(bundle);

function apply(oldText, steps) {
  let out = "", cur = 0;
  for (const s of steps) { out += oldText.slice(cur, s.start) + s.replacement; cur = s.end; }
  return out + oldText.slice(cur);
}

test("ceiling: 30k mostly-distinct lines returns a coarse block promptly, byte-exact", () => {
  const oldText = Array.from({ length: 30000 }, (_, i) => `alpha line ${i}`).join("\n") + "\n";
  const newText = Array.from({ length: 30000 }, (_, i) => `bravo line ${i}`).join("\n") + "\n";
  const t0 = process.hrtime.bigint();
  const steps = lineDiffSteps(oldText, newText);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(apply(oldText, steps), newText, "must reconstruct byte-exact");
  // The old O(m*n) sweep took ~12.7s here. The ceiling makes it a near-instant
  // block replace. A generous bound catches a re-regression without being flaky.
  assert.ok(ms < 1500, `expected prompt return, took ${ms.toFixed(0)}ms`);
});

test("below ceiling: 4k-line file with scattered edits stays granular and byte-exact", () => {
  const base = Array.from({ length: 4000 }, (_, i) => `row ${i}`);
  const oldText = base.join("\n") + "\n";
  const edited = base.slice();
  for (let k = 0; k < 15; k++) edited[k * 260 + 11] = `CHANGED ${k}`;
  const newText = edited.join("\n") + "\n";
  const steps = lineDiffSteps(oldText, newText);
  assert.strictEqual(apply(oldText, steps), newText, "must reconstruct byte-exact");
  const changed = steps.reduce((n, s) => n + (s.originalText ? s.originalText.split("\n").length : 0) + s.replacement.split("\n").length, 0);
  assert.ok(steps.length >= 10, `expected granular hunks, got ${steps.length}`);
  assert.ok(changed < 150, `expected localized changes, got ${changed} lines across hunks`);
});
