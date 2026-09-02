// Oracle for the dwell (src/disclosure/dwell.ts): the beat between a step
// landing and the replay jumping to the next one.
//
// The invariant that earns this file: the next step runs EXACTLY ONCE. The
// dwell has two ways to resolve (the clock elapsing, and a gesture taking it)
// and they race — the timer can already be in flight when Tab lands. Running
// the step twice means a second walk starting on a buffer the first one is
// already editing.
//
// The clock is injected, so the tests drive time rather than sleeping.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".dwell.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/dwell.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
});
const { DwellGate } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

// A hand-driven clock: nothing fires until the test advances it.
function fakeClock() {
  let t = 1000;
  let seq = 0;
  const pending = new Map();
  return {
    clock: {
      now: () => t,
      after(ms, fn) {
        const id = ++seq;
        pending.set(id, { at: t + ms, fn });
        return id;
      },
      cancel(id) {
        pending.delete(id);
      },
    },
    advance(ms) {
      t += ms;
      for (const [id, e] of [...pending]) {
        if (e.at <= t) {
          pending.delete(id);
          e.fn();
        }
      }
    },
    get live() {
      return pending.size;
    },
  };
}

function gate(holdMs = 3000) {
  const c = fakeClock();
  const ran = [];
  const dwell = new DwellGate(c.clock, (next) => ran.push(next));
  return { c, ran, dwell, holdMs };
}

test("a hold elapses on its own into the step it was holding in front of", () => {
  const { c, ran, dwell } = gate();
  assert.strictEqual(dwell.hold(4, 3000), true);
  c.advance(2999);
  assert.deepStrictEqual(ran, [], "the dwell moved before its time was up");
  c.advance(1);
  assert.deepStrictEqual(ran, [4]);
  assert.strictEqual(dwell.info, undefined, "an elapsed dwell must disarm itself");
});

test("remainingMs counts down and never goes negative", () => {
  const { c, dwell } = gate();
  dwell.hold(1, 3000);
  assert.strictEqual(dwell.info.remainingMs, 3000);
  c.advance(1200);
  assert.strictEqual(dwell.info.remainingMs, 1800);
  assert.strictEqual(dwell.info.mode, "holding");
});

test("Tab takes the dwell: the step comes back once, and the dead timer fires nothing", () => {
  const { c, ran, dwell } = gate();
  dwell.hold(7, 3000);
  assert.strictEqual(dwell.take(), 7);
  assert.strictEqual(dwell.info, undefined);
  c.advance(10000);
  assert.deepStrictEqual(ran, [], "the elapse fired on a dwell the human had already taken");
});

test("take() is answered once — a second gesture gets nothing to run", () => {
  const { dwell } = gate();
  dwell.hold(2, 3000);
  assert.strictEqual(dwell.take(), 2);
  assert.strictEqual(dwell.take(), undefined);
});

test("Esc parks: the clock dies, the dwell stays armed, and nothing moves", () => {
  const { c, ran, dwell } = gate();
  dwell.hold(5, 3000);
  assert.strictEqual(dwell.park(), true);
  assert.strictEqual(c.live, 0, "parking left a timer running");
  c.advance(60_000);
  assert.deepStrictEqual(ran, [], "a parked dwell elapsed anyway");
  assert.strictEqual(dwell.info.mode, "parked");
  assert.strictEqual(dwell.info.next, 5, "a parked dwell forgot which step it was holding");
  assert.strictEqual(dwell.info.remainingMs, 0);
});

test("a parked dwell still hands its step to the next run gesture", () => {
  const { c, dwell } = gate();
  dwell.hold(9, 3000);
  dwell.park();
  c.advance(120_000);
  assert.strictEqual(dwell.take(), 9);
  assert.strictEqual(dwell.info, undefined);
});

test("parking twice is a no-op, and parking nothing is a no-op", () => {
  const { dwell } = gate();
  assert.strictEqual(dwell.park(), false, "parked a dwell that was not pending");
  dwell.hold(3, 3000);
  assert.strictEqual(dwell.park(), true);
  assert.strictEqual(dwell.park(), false);
  assert.strictEqual(dwell.info.next, 3);
});

test("clear drops the dwell without running the step (cancel, skip, unload)", () => {
  const { c, ran, dwell } = gate();
  dwell.hold(6, 3000);
  dwell.clear();
  assert.strictEqual(c.live, 0);
  c.advance(10_000);
  assert.deepStrictEqual(ran, []);
  assert.strictEqual(dwell.info, undefined);
});

test("a zero hold is not a dwell: it refuses and arms nothing", () => {
  const { c, ran, dwell } = gate();
  assert.strictEqual(dwell.hold(1, 0), false);
  assert.strictEqual(dwell.info, undefined);
  assert.strictEqual(c.live, 0);
  c.advance(10_000);
  assert.deepStrictEqual(ran, [], "a disabled dwell still moved the replay");
  assert.strictEqual(dwell.hold(1, -5), false);
});

test("a new hold replaces the old one: one timer, one elapse", () => {
  const { c, ran, dwell } = gate();
  dwell.hold(1, 3000);
  c.advance(1000);
  dwell.hold(2, 3000);
  assert.strictEqual(c.live, 1, "the replaced hold left its timer alive");
  c.advance(3000);
  assert.deepStrictEqual(ran, [2]);
});
