// Oracle for the observed-delta ledger (src/disclosure/ledger.ts).
//
// The invariant: a pure insert's baked point, pushed through the ledger's
// arrival-ordered edits, lands where those bytes actually sit in the live
// buffer — or comes back dirty when an edit rewrote the point itself. The live
// incident this exists for: a 175-byte foreign ghost upstream of two armed
// inserts landed both exactly 175 bytes stale, one splitting a comment word,
// one splitting an indent. The transform is pure byte arithmetic; nothing here
// (or in the module) consults content.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".ledger.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/ledger.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
});
const { transformPoint, bookObserved } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

// --- the incident and the spike shapes, at transform grain -----------------

test("incident: a 175-byte foreign insert upstream shifts the point by exactly 175", () => {
  const r = transformPoint(100, [{ offset: 40, rangeLength: 0, textLength: 175 }]);
  assert.deepStrictEqual(r, { point: 275, dirty: false });
});

test("deletion upstream pulls the point left by the deleted length", () => {
  const r = transformPoint(100, [{ offset: 10, rangeLength: 5, textLength: 0 }]);
  assert.deepStrictEqual(r, { point: 95, dirty: false });
});

test("replacement ending exactly at the point counts as upstream (bytes left of the point moved)", () => {
  const r = transformPoint(100, [{ offset: 97, rangeLength: 3, textLength: 10 }]);
  assert.deepStrictEqual(r, { point: 107, dirty: false });
});

test("edit at or right of the point leaves it alone", () => {
  assert.deepStrictEqual(transformPoint(100, [{ offset: 100, rangeLength: 4, textLength: 0 }]), { point: 100, dirty: false });
  assert.deepStrictEqual(transformPoint(100, [{ offset: 150, rangeLength: 0, textLength: 30 }]), { point: 100, dirty: false });
});

test("FOREIGN insert exactly AT the point does not shift it (whose-bytes-first is the context gate's call)", () => {
  const r = transformPoint(100, [{ offset: 100, rangeLength: 0, textLength: 20 }]);
  assert.deepStrictEqual(r, { point: 100, dirty: false });
});

test("SELF insert exactly AT the point shifts it — our own bytes always precede later steps", () => {
  // The hunt's 4d/5f: without the self bit, a later step baked at our own
  // pure insert's point held clean BEFORE our bytes, inverting step order.
  const r = transformPoint(100, [{ offset: 100, rangeLength: 0, textLength: 20, self: true }]);
  assert.deepStrictEqual(r, { point: 120, dirty: false });
});

test("edit straddling the point is dirty, and dirty never clears", () => {
  const edits = [
    { offset: 98, rangeLength: 5, textLength: 2 }, // rewrites the point's bytes
    { offset: 0, rangeLength: 0, textLength: 50 }, // a later clean edit can't launder it
  ];
  assert.strictEqual(transformPoint(100, edits).dirty, true);
});

test("undo burst: an edit followed by its exact inverse restores the original point", () => {
  const edits = [
    { offset: 40, rangeLength: 0, textLength: 175 }, // foreign insert
    { offset: 40, rangeLength: 175, textLength: 0 }, // its undo
  ];
  assert.deepStrictEqual(transformPoint(100, edits), { point: 100, dirty: false });
});

test("split change event: one logical insert delivered as two changes shifts by the sum", () => {
  // One 175-byte paste VS Code reports as two contentChanges, booked
  // right-to-left (the controller sorts descending): both upstream.
  const edits = [
    { offset: 60, rangeLength: 0, textLength: 75 },
    { offset: 40, rangeLength: 0, textLength: 100 },
  ];
  assert.deepStrictEqual(transformPoint(100, edits), { point: 275, dirty: false });
});

test("self and foreign interleave in arrival order (the sum selfDelta can't order)", () => {
  // Buffer story around a baked point 20: our accept replaces [5,10) with 8
  // bytes (delta +3, point → 23), then a foreign edit lands at 22 — INSIDE
  // what a bare sum would still call upstream-of-24 — deleting 1 byte before
  // the shifted point... offset 22 < 23, ends at 23 → upstream, point → 22.
  const edits = [
    { offset: 5, rangeLength: 5, textLength: 8 },
    { offset: 22, rangeLength: 1, textLength: 0 },
  ];
  assert.deepStrictEqual(transformPoint(20, edits), { point: 22, dirty: false });
});

// --- property: the transform tracks the byte the point was glued to --------
//
// Ground truth by simulation: a buffer of unique bytes, a marker = the byte at
// the baked point; apply arbitrary non-straddling edits to the real string;
// the transformed point must equal the marker byte's live index. Seeded LCG —
// reproducible, no ambient randomness.

test("property: 500 random non-straddling edit sequences track the marker byte exactly", () => {
  let seed = 0xC0FFEE;
  const rnd = (n) => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed % n);
  for (let round = 0; round < 500; round++) {
    const size = 64 + rnd(64);
    let buf = Array.from({ length: size }, (_, i) => i); // unique byte ids
    const point = 1 + rnd(size - 2);
    const marker = buf[point];
    const edits = [];
    for (let k = 0, n = 1 + rnd(6); k < n; k++) {
      const insert = rnd(2) === 0;
      if (insert) {
        // Inserts never straddle. An insert exactly AT the point is excluded:
        // the module deliberately holds the point there (whose-bytes-first is
        // the context gate's call — see the deterministic test), while this
        // simulation's marker byte would shift right.
        const at = rnd(buf.length + 1);
        if (at === buf.indexOf(marker)) { k--; continue; }
        const len = 1 + rnd(20);
        edits.push({ offset: at, rangeLength: 0, textLength: len });
        buf = [...buf.slice(0, at), ...Array.from({ length: len }, () => -1), ...buf.slice(at)];
      } else {
        const markerAt = buf.indexOf(marker);
        // A delete/replace whose range never touches the marker's slot — a
        // delete starting AT the point removes the marker byte itself, where
        // this simulation's ground truth goes blind (the deterministic
        // "edit at or right of the point" test pins that boundary).
        const at = rnd(buf.length);
        if (at === markerAt) { k--; continue; }
        const maxLen = at < markerAt ? markerAt - at : buf.length - at;
        if (maxLen === 0) { k--; continue; }
        const del = 1 + rnd(Math.min(12, maxLen));
        const ins = rnd(8); // replacement bytes (may be zero — pure delete)
        edits.push({ offset: at, rangeLength: del, textLength: ins });
        buf = [...buf.slice(0, at), ...Array.from({ length: ins }, () => -1), ...buf.slice(at + del)];
      }
    }
    const r = transformPoint(point, edits);
    assert.strictEqual(r.dirty, false, `round ${round}: unexpectedly dirty`);
    assert.strictEqual(r.point, buf.indexOf(marker), `round ${round}: point drifted`);
  }
});

test("property: any edit strictly spanning the point reports dirty", () => {
  let seed = 0xBADF00D;
  const rnd = (n) => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed % n);
  for (let round = 0; round < 200; round++) {
    const point = 10 + rnd(100);
    const before = 1 + rnd(9);
    const span = before + 1 + rnd(10); // starts before, ends after the point
    const r = transformPoint(point, [{ offset: point - before, rangeLength: span, textLength: rnd(20) }]);
    assert.strictEqual(r.dirty, true, `round ${round}`);
  }
});

// --- bookObserved: window agreement ----------------------------------------

const W = { anchorOffset: 100, symbolLen: 50 };

test("bookObserved: edit fully before the anchor is absorbed by the window shift — null", () => {
  assert.strictEqual(bookObserved(W, { rangeOffset: 20, rangeLength: 80, textLength: 3 }), null);
});

test("bookObserved: edit past the window end still books — no end gate (hunt 1b: a drifted window end nulled an inside edit; over-booking right of every point is a no-op)", () => {
  assert.deepStrictEqual(bookObserved(W, { rangeOffset: 151, rangeLength: 0, textLength: 9 }), { offset: 51, rangeLength: 0, textLength: 9 });
});

test("bookObserved: append exactly at the window end books (shiftWindow grows the window for it)", () => {
  assert.deepStrictEqual(bookObserved(W, { rangeOffset: 150, rangeLength: 0, textLength: 9 }), { offset: 50, rangeLength: 0, textLength: 9 });
});

test("bookObserved: inside edit books symbol-relative", () => {
  assert.deepStrictEqual(bookObserved(W, { rangeOffset: 130, rangeLength: 4, textLength: 1 }), { offset: 30, rangeLength: 4, textLength: 1 });
});

test("bookObserved: edit straddling the window start books its TRUE negative offset (hunt 3e: the zero-clamp let a straddle+undo drift the anchor while a rel-0 point stayed clean)", () => {
  assert.deepStrictEqual(bookObserved(W, { rangeOffset: 95, rangeLength: 10, textLength: 2 }), { offset: -5, rangeLength: 10, textLength: 2 });
});

test("bookObserved: a negative-offset straddle makes a rel-0 point DIRTY, and interior points stay exact", () => {
  const e = bookObserved(W, { rangeOffset: 95, rangeLength: 10, textLength: 2 });
  assert.strictEqual(transformPoint(0, [e]).dirty, true);
  assert.deepStrictEqual(transformPoint(20, [e]), { point: 12, dirty: false });
});

test("bookObserved: SELF zero-length insert exactly at the anchor books at rel 0 (hunt 5a: the self filter skips shiftWindow, so an unbooked self insert was tracked by nobody)", () => {
  assert.deepStrictEqual(
    bookObserved(W, { rangeOffset: 100, rangeLength: 0, textLength: 8 }, true),
    { offset: 0, rangeLength: 0, textLength: 8, self: true },
  );
  // The foreign twin is absorbed by the anchor shift instead — null.
  assert.strictEqual(bookObserved(W, { rangeOffset: 100, rangeLength: 0, textLength: 8 }), null);
});

test("bookObserved: SELF changes book unconditionally, even left of the anchor (re-hunt residual 1: an accept at a legitimately negative-rel point booked null and went untracked)", () => {
  assert.deepStrictEqual(
    bookObserved(W, { rangeOffset: 92, rangeLength: 0, textLength: 8 }, true),
    { offset: -8, rangeLength: 0, textLength: 8, self: true },
  );
});

test("transformPoint: a running point pushed negative reports dirty (re-hunt residual 2: before-anchor edits are absorbed unbooked, so no clean answer exists left of the anchor)", () => {
  // A start-straddle legitimately pushes a small-rel point negative…
  const straddle = { offset: -14, rangeLength: 15, textLength: 0 };
  const r = transformPoint(1, [straddle]);
  assert.strictEqual(r.dirty, true);
  // …and dirty holds even if later edits shift it back above zero.
  const back = transformPoint(1, [straddle, { offset: -20, rangeLength: 0, textLength: 40 }]);
  assert.strictEqual(back.dirty, true);
});
