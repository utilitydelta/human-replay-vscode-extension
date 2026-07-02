// Unit tests for the model-pull progress aggregate (src/ollama.ts PullProgress).
//
// The one-click model download reports a single percentage over Ollama's
// interleaved per-layer pull events. The invariant: the fraction is monotonic
// non-decreasing across a well-formed pull, unknown-size phases report no
// fraction, and re-reports of the same layer update rather than double-count.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".pull-progress.bundle.cjs");
const entry = path.join(__dirname, ".pull-progress.entry.ts");
fs.writeFileSync(entry, `export { PullProgress } from "../src/ollama";\n`);
esbuild.buildSync({ entryPoints: [entry], bundle: true, outfile: bundle, format: "cjs", platform: "node" });
const { PullProgress } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

test("no fraction until a layer reports a size", () => {
  const p = new PullProgress();
  assert.strictEqual(p.note({ status: "pulling manifest" }), undefined);
  assert.strictEqual(p.note({ status: "verifying sha256 digest" }), undefined);
});

test("interleaved layers aggregate; re-reports update, never double-count", () => {
  const p = new PullProgress();
  assert.strictEqual(p.note({ digest: "a", total: 100, completed: 0 }), 0);
  assert.strictEqual(p.note({ digest: "b", total: 100, completed: 0 }), 0);
  assert.strictEqual(p.note({ digest: "a", total: 100, completed: 50 }), 0.25);
  assert.strictEqual(p.note({ digest: "b", total: 100, completed: 50 }), 0.5);
  assert.strictEqual(p.note({ digest: "a", total: 100, completed: 100 }), 0.75);
  assert.strictEqual(p.note({ digest: "b", total: 100, completed: 100 }), 1);
});

test("fraction is monotonic across a realistic event stream", () => {
  const p = new PullProgress();
  const events = [
    { status: "pulling manifest" },
    { digest: "big", total: 1000, completed: 0 },
    { digest: "big", total: 1000, completed: 400 },
    { digest: "small", total: 10, completed: 0 },
    { digest: "big", total: 1000, completed: 1000 },
    { digest: "small", total: 10, completed: 10 },
    { status: "success" },
  ];
  let last = 0;
  for (const e of events) {
    const f = p.note(e);
    if (f === undefined) continue;
    assert.ok(f >= last - 1e-9, `fraction went backwards: ${last} → ${f}`);
    last = f;
  }
  assert.strictEqual(last, 1);
});
