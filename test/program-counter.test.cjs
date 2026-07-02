// Unit tests for the replay program counter (src/disclosure/programCounter.ts).
//
// The bug this guards against: a single integer counter marks every step below it
// "done", so jumping to step 5 falsely greens 2-4 and jumping back un-greens real
// progress. Explicit done/skipped/blocked sets fix that — these pin the status
// precedence and the next/position/complete logic the panel relies on.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".pc.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/programCounter.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
});
const { ProgramCounter } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

const fresh = (n) => {
  const pc = new ProgramCounter();
  pc.reset(n);
  return pc;
};

test("fresh: step 0 is current, the rest pending; next is 0", () => {
  const pc = fresh(4);
  assert.strictEqual(pc.status(0), "current");
  assert.deepStrictEqual([pc.status(1), pc.status(2), pc.status(3)], ["pending", "pending", "pending"]);
  assert.strictEqual(pc.next(), 0);
  assert.strictEqual(pc.isComplete, false);
});

test("begin then complete: the walked step is done, next moves on", () => {
  const pc = fresh(3);
  pc.begin(0);
  assert.strictEqual(pc.status(0), "current");
  assert.ok(pc.complete());
  assert.strictEqual(pc.status(0), "done");
  assert.strictEqual(pc.status(1), "current");
  assert.strictEqual(pc.next(), 1);
});

test("jumping to a later step does NOT mark the skipped-over ones done (the bug)", () => {
  const pc = fresh(5);
  pc.begin(3);
  pc.complete();
  assert.strictEqual(pc.status(3), "done");
  // 0,1,2 were never run — they must not be "done"
  assert.deepStrictEqual([pc.status(0), pc.status(1), pc.status(2)], ["current", "pending", "pending"]);
  assert.strictEqual(pc.next(), 0, "next is still the earliest unrun step");
});

test("skip: the step is skipped, next steps past it, it never becomes done", () => {
  const pc = fresh(3);
  pc.skip(0);
  assert.strictEqual(pc.status(0), "skipped");
  assert.strictEqual(pc.next(), 1);
  assert.strictEqual(pc.status(1), "current");
});

test("block: a collision marks the in-flight step blocked and frees inFlight", () => {
  const pc = fresh(3);
  pc.begin(0);
  assert.ok(pc.block());
  assert.strictEqual(pc.inFlightIndex, undefined);
  // step 0 is still the next unrun step, but blocked precedence beats current
  assert.strictEqual(pc.next(), 0);
  assert.strictEqual(pc.status(0), "blocked");
});

test("skipping a blocked step clears the block and advances", () => {
  const pc = fresh(2);
  pc.begin(0);
  pc.block();
  pc.skip(0);
  assert.strictEqual(pc.status(0), "skipped");
  assert.strictEqual(pc.next(), 1);
});

test("complete/block are no-ops with nothing in flight", () => {
  const pc = fresh(2);
  assert.strictEqual(pc.complete(), false);
  assert.strictEqual(pc.block(), false);
});

test("status precedence: done > skipped is moot, but blocked > done after a re-run block", () => {
  const pc = fresh(2);
  pc.begin(0);
  pc.complete(); // 0 done
  pc.begin(0); // re-run 0
  pc.block(); // now blocked
  assert.strictEqual(pc.status(0), "blocked", "blocked wins over a prior done");
});

test("isComplete only when every step is done or skipped and nothing flies", () => {
  const pc = fresh(2);
  pc.begin(0);
  pc.complete();
  assert.strictEqual(pc.isComplete, false);
  pc.skip(1);
  assert.strictEqual(pc.isComplete, true);
  assert.strictEqual(pc.next(), 2); // == total
});

test("reset clears all state", () => {
  const pc = fresh(2);
  pc.begin(0);
  pc.complete();
  pc.reset(3);
  assert.strictEqual(pc.completedCount, 0);
  assert.strictEqual(pc.status(0), "current");
  assert.strictEqual(pc.next(), 0);
});

test("markDone: counts as done, clears skip/block, ignores out-of-range", () => {
  const pc = fresh(3);
  pc.skip(1);
  pc.markDone(1);
  assert.strictEqual(pc.status(1), "done", "markDone overrides a prior skip");
  pc.markDone(-1);
  pc.markDone(3); // == total: a stale snapshot index against a shorter guide
  assert.strictEqual(pc.completedCount, 1);
  assert.strictEqual(pc.next(), 0);
});

test("snapshot/restore round-trip: done + skipped survive, in-flight does not", () => {
  const pc = fresh(4);
  pc.begin(0);
  pc.complete(); // 0 done
  pc.skip(2);
  pc.begin(1); // in-flight — a live-session state, not persistable
  const snap = pc.snapshot();
  assert.deepStrictEqual(snap, { done: [0], skipped: [2] });

  const restored = fresh(4);
  restored.restore(snap);
  assert.strictEqual(restored.status(0), "done");
  assert.strictEqual(restored.status(2), "skipped");
  assert.strictEqual(restored.next(), 1, "resume points at the first unresolved step");
});

test("restore merges — union with live progress, never un-does it", () => {
  const pc = fresh(3);
  pc.begin(2);
  pc.complete(); // live progress: 2 done
  pc.restore({ done: [0], skipped: [2] }); // stale snapshot says 2 was skipped
  assert.strictEqual(pc.status(0), "done");
  assert.strictEqual(pc.status(2), "done", "a live done beats a snapshot skip");
  assert.strictEqual(pc.next(), 1);
});

test("restore ignores indices past the guide's end (re-edited guide, stale snapshot)", () => {
  const pc = fresh(2);
  pc.restore({ done: [0, 7], skipped: [9] });
  assert.strictEqual(pc.completedCount, 1);
  assert.strictEqual(pc.next(), 1);
});

test("cancelInFlight: nothing lands, and a stray complete() can't mark the step done", () => {
  const pc = fresh(3);
  pc.begin(1);
  assert.ok(pc.cancelInFlight());
  assert.strictEqual(pc.status(1), "pending", "the cancelled step keeps its prior status");
  assert.strictEqual(pc.complete(), false, "a completion event after cancel is a no-op");
  assert.strictEqual(pc.status(1), "pending");
  assert.strictEqual(pc.cancelInFlight(), false, "cancel with nothing in flight reports so");
});
