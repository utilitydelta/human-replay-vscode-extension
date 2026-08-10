// The incident oracle: replays the recorded bloom-at-seal step 2.1 (`sync`,
// shard_wal_sync.rs) from shipped corpus bytes, then injects the exact
// foreign edit forensics recovered — a 175-byte model-invented ghost (it names
// a MetablockKind::EventBatch variant the enum does not have) Tab-accepted
// while the extension's own step was armed. Pre-fix, both downstream pure
// inserts landed exactly 175 bytes stale, one splitting a comment word, one
// splitting an indent, and nothing surfaced. The invariant pinned here:
//
//   - happy path: byte-exact, zero collisions (the proof gate is free);
//   - with the foreign edit booked, every pure insert lands at its CORRECT
//     spot via the ledger transform + dual-context ratification;
//   - doppelganger shapes (attach line duplicated above the point, two-line
//     block dup, doomed-tail copy with the true attach line rewritten) either
//     land at the true spot or COLLIDE — a silent wrong landing fails loud.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const entry = path.join(__dirname, ".insert-proof.entry.ts");
const bundle = path.join(__dirname, ".insert-proof.bundle.cjs");
fs.writeFileSync(
  entry,
  `export { buildReplaySteps } from "../src/disclosure/sequence";\n` +
    `export { resolveStep } from "../src/disclosure/replay";\n` +
    `export { parseRoot } from "../src/disclosure/diff";\n` +
    `export { explainInsertCollision, resolveInsertPoint } from "../src/disclosure/proof";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { buildReplaySteps, resolveStep, parseRoot, explainInsertCollision, resolveInsertPoint } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const OLD = fs.readFileSync(path.join(__dirname, "corpus/corpus-old-sync.rs"), "utf8");
const NEW = fs.readFileSync(path.join(__dirname, "corpus/corpus-new-sync.rs"), "utf8");
const FOREIGN = fs.readFileSync(path.join(__dirname, "corpus/corpus-foreign-edit.txt"), "utf8");

assert.strictEqual(FOREIGN.length, 175, "the shipped foreign edit is the incident's exact 175 bytes");

// The controller's sequential policy with an event hook: `events[i]` runs
// before step i resolves and returns splices — foreign edits applied to the
// buffer in order (each in then-current coordinates) and booked into the
// ledger, exactly as noteChange would live. Returns the final buffer, or the
// index of the first collision.
function replay(steps, events = {}) {
  let buf = OLD;
  let selfDelta = 0;
  const ledger = [];
  for (const [i, st] of steps.entries()) {
    for (const { offset, del, text } of events[i]?.(buf, ledger) ?? []) {
      buf = buf.slice(0, offset) + text + buf.slice(offset + del);
      ledger.push({ offset, rangeLength: del, textLength: text.length });
    }
    const r = resolveStep(buf, parseRoot(buf), st, selfDelta, ledger);
    if (!r) return { collidedAt: i, buf };
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
    ledger.push({ offset: r[0], rangeLength: r[1] - r[0], textLength: st.replacement.length, self: true });
  }
  return { buf };
}

const steps = buildReplaySteps(OLD, NEW);
const inserts = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.originalText === "");

test("corpus sanity: the sync diff is multi-hunk with at least two pure inserts", () => {
  assert.ok(steps.length >= 3, `expected a multi-hunk diff, got ${steps.length} step(s)`);
  assert.ok(inserts.length >= 2, `expected >= 2 pure inserts (the incident's shape), got ${inserts.length}`);
});

test("census: every pure insert bakes non-empty proof (a side of bytes, or the end-of-symbol rule)", () => {
  let delta = 0;
  for (const st of steps) {
    if (st.originalText === "") {
      assert.ok(st.proof, "proof must be baked");
      const point = st.start + delta;
      const usable = st.proof.left.trim() !== "" || st.proof.right.trim() !== "" || point === NEW.length;
      assert.ok(usable, `insert at old offset ${st.start} bakes only blank proof away from the symbol end`);
    }
    delta += st.replacement.length - (st.end - st.start);
  }
});

test("happy path: sequential replay is byte-exact with zero collisions (the proof gate costs nothing)", () => {
  const { buf, collidedAt } = replay(steps);
  assert.strictEqual(collidedAt, undefined, `collision at step ${collidedAt}`);
  assert.strictEqual(buf, NEW);
});

test("incident: the 175-byte foreign ghost lands while the block step arms — both inserts still land byte-exact", () => {
  // The recorded shape: the ghost was fed into the ARMED BLOCK step's own
  // anchor (step 0 — it landed right anyway, via its content leg); the two
  // pure inserts downstream were the casualties. Inject at step 0's resolved
  // point before it serves.
  const events = {
    0: (buf, ledger) => {
      const r = resolveStep(buf, parseRoot(buf), steps[0], ledgerDelta(ledger), ledger);
      assert.ok(r, "the armed step must resolve pre-injection");
      return [{ offset: r[0], del: 0, text: FOREIGN }];
    },
  };
  const { buf, collidedAt } = replay(steps, events);
  assert.strictEqual(collidedAt, undefined, `collision at step ${collidedAt} — the incident expects landings`);
  // Byte-exact modulo the foreign bytes, which appear exactly once, intact —
  // no insert split them and none landed stale inside them.
  const parts = buf.split(FOREIGN);
  assert.strictEqual(parts.length, 2, "the foreign bytes survive exactly once, unsplit");
  assert.strictEqual(parts.join(""), NEW);
});

// selfDelta equivalent of a ledger built only from our own accepts — the
// incident event needs the armed step's pre-injection point.
function ledgerDelta(ledger) {
  return ledger.reduce((d, e) => d + e.textLength - e.rangeLength, 0);
}

// The bloom-at-seal 4.1 freeze: a file-walk block segment (oldSrc "") bakes a
// blank-both-sides proof, and the arm's own edit fires a selection event on a
// half-booked window — symText still "", the self insert already in the
// ledger. resolveInsertPoint correctly collides; the forensic line must then
// TERMINATE. Pre-fix, indexOf("") never returned -1 and the counting loop
// pinned the extension host forever — a regression here hangs the whole
// suite, which is the loud failure we want.
test("forensics: explainInsertCollision terminates on a blank-left proof (file-walk block segment mid-arm)", () => {
  const step = { start: 0, proof: { left: "", right: "" } };
  const ledger = [{ offset: 0, rangeLength: 0, textLength: 20, self: true }];
  assert.strictEqual(resolveInsertPoint("", step, ledger, null), null, "the stale window must collide, not land");
  const why = explainInsertCollision("", step, ledger);
  assert.ok(why.includes("no left bytes to search"), `forensics must name the blank left side, got: ${why}`);
});

// --- doppelganger shapes, per pure insert ----------------------------------
//
// Each scenario runs the happy path up to the insert, injects its shape as a
// foreign event, and demands: land at the TRUE spot (plain arithmetic on the
// constructed event, computed here in the test) or collide. Any other landing
// is the silent 175-byte class again.

function doppelganger(name, makeEvent) {
  for (const { i } of inserts) {
    test(`${name} on insert step ${i}: lands true or collides — never silently wrong`, () => {
      let expected;
      const events = {
        [i]: (buf, ledger) => {
          const point = resolvePoint(buf, ledger, i);
          const evs = makeEvent(buf, point);
          // The true landing: each constructed splice's delta applied to the
          // point by hand — no engine code in the expectation. Splices after
          // the first are constructed to sit past the point, so only
          // at-or-before deltas move it.
          expected = point;
          for (const ev of evs) if (ev.offset + ev.del <= expected) expected += ev.text.length - ev.del;
          return evs;
        },
      };
      const { buf, collidedAt } = replay(steps, events);
      if (collidedAt !== undefined) {
        assert.ok(collidedAt >= i, `collided at ${collidedAt}, before the shape at ${i}`);
        return; // fail-loud is a correct outcome
      }
      // Landed: the insert's bytes must sit exactly at the expected point.
      const st = steps[i];
      assert.strictEqual(
        buf.slice(expected, expected + st.replacement.length),
        st.replacement,
        "landed somewhere other than the true spot",
      );
    });
  }
}

// The insert's live point just before it resolves (its own legs, pre-event).
function resolvePoint(buf, ledger, i) {
  const r = resolveStep(buf, parseRoot(buf), steps[i], ledgerDelta(ledger), ledger);
  assert.ok(r, "the insert must resolve pre-event");
  return r[0];
}

doppelganger("attach line duplicated above the point", (buf, point) => {
  const lineStart = buf.lastIndexOf("\n", point - 1) + 1;
  const lineEnd = buf.indexOf("\n", lineStart);
  const line = buf.slice(lineStart, lineEnd < 0 ? buf.length : lineEnd + 1);
  return [{ offset: lineStart, del: 0, text: line }];
});

doppelganger("two-line block duplicated above the point", (buf, point) => {
  const lineStart = buf.lastIndexOf("\n", point - 1) + 1;
  const nl1 = buf.indexOf("\n", lineStart);
  const nl2 = nl1 < 0 ? -1 : buf.indexOf("\n", nl1 + 1);
  const block = buf.slice(lineStart, nl2 < 0 ? buf.length : nl2 + 1);
  return [{ offset: lineStart, del: 0, text: block }];
});

doppelganger("doomed-tail copy + true attach line rewritten", (buf, point) => {
  // The R1c bait: rewrite the true attach bytes left of the point, then plant
  // a copy of the original attach bytes at a line start deep in the unlanded
  // tail. The content leg's unique left-context match now points into doomed
  // bytes; the frontier must reject it. Second splice sits past the point, so
  // only the rewrite's delta (zero) moves the expectation.
  const lineStart = buf.lastIndexOf("\n", point - 1) + 1;
  const attach = buf.slice(lineStart, point);
  if (attach.trim() === "") return []; // nothing to bait with
  const rewritten = attach.replace(/[A-Za-z]/g, "q");
  const tailLineStart = buf.lastIndexOf("\n") + 1;
  return [
    { offset: lineStart, del: point - lineStart, text: rewritten },
    { offset: Math.max(tailLineStart, point), del: 0, text: attach + "\n" },
  ];
});
