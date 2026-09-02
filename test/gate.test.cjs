// Oracle for the retrospective gate state machine (src/retrospective/gate.ts).
//
// The gate is the forced pause between a landed step and the next one. Nothing
// here is inferred: every choice is a real line from the guide, and the only
// computed things are the shuffle (seeded by step id + question text, so step
// 2.3's answer does not sit in the same slot in every guide) and the lockout
// window. These tests pin the machine black-box: permutation, seeding, the
// wrong/locked/eliminated/passed verdicts, and the reload round trip.
//
// The clock is injected, so time here is exact — no sleeping, no mocks.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".gate.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/retrospective/gate.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
});
const { RetroGate } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

// --- harness ---------------------------------------------------------------

const CHOICES = [
  { text: "Because the ledger transforms unlanded points OT-style.", correct: true },
  { text: "Because the anchor is re-resolved on every keystroke.", correct: false },
  { text: "Because the sandbox bytes are re-read before each accept.", correct: false },
];

const QUESTION = "Why does a foreign edit upstream not land the insert stale?";
const LOCKOUT = 5000;

/** Injected clock: `clock.t` is the epoch ms the gate sees. */
const clockAt = (t0) => {
  const c = { t: t0 };
  c.now = () => c.t;
  c.advance = (ms) => (c.t += ms);
  return c;
};

const opts = (clock, over = {}) => ({
  stepId: "2.3",
  question: QUESTION,
  choices: CHOICES,
  lockoutMs: LOCKOUT,
  now: clock.now,
  ...over,
});

const texts = (gate) => gate.order.map((c) => c.text);
const correctIndex = (gate) => gate.order.findIndex((c) => c.correct);
const wrongIndices = (gate) => gate.order.map((c, i) => (c.correct ? -1 : i)).filter((i) => i >= 0);

/** Everything the machine exposes, for "nothing changed" assertions. */
const snap = (gate) => ({
  order: texts(gate),
  survivors: gate.survivors.slice(),
  wrongCount: gate.wrongCount,
  passed: gate.passed,
  locked: gate.locked,
  remaining: gate.lockoutRemainingMs,
});

// --- 1. the choices are the guide's, untouched ------------------------------

test("order is a permutation of the input choices — same texts, same correct flags, nothing invented or dropped", () => {
  const gate = new RetroGate(opts(clockAt(1_000)));
  assert.strictEqual(gate.order.length, 3);
  assert.deepStrictEqual(texts(gate).slice().sort(), CHOICES.map((c) => c.text).sort());
  assert.strictEqual(gate.order.filter((c) => c.correct).length, 1);
  for (const shown of gate.order) {
    const source = CHOICES.find((c) => c.text === shown.text);
    assert.ok(source, `invented choice: ${shown.text}`);
    assert.strictEqual(shown.correct, source.correct, "a shuffled choice kept its own correct flag");
  }
});

test("a fresh gate offers all three choices, none wrong, not passed, not locked", () => {
  const gate = new RetroGate(opts(clockAt(1_000)));
  assert.deepStrictEqual(gate.survivors, [0, 1, 2]);
  assert.strictEqual(gate.wrongCount, 0);
  assert.strictEqual(gate.passed, false);
  assert.strictEqual(gate.locked, false);
  assert.strictEqual(gate.lockoutRemainingMs, 0);
  assert.strictEqual(gate.stepId, "2.3");
  assert.strictEqual(gate.question, QUESTION);
});

// --- 2. the shuffle is seeded, not random -----------------------------------

test("same stepId + question shuffles identically — the order is stable across re-shows", () => {
  const a = new RetroGate(opts(clockAt(1_000)));
  const b = new RetroGate(opts(clockAt(1_000)));
  assert.deepStrictEqual(texts(a), texts(b));
});

test("the shuffle ignores the clock, the construction time and the lockout length", () => {
  const base = new RetroGate(opts(clockAt(1_000)));
  const later = new RetroGate(opts(clockAt(9_999_999_999)));
  const other = new RetroGate(opts(clockAt(42), { lockoutMs: 250_000 }));
  assert.deepStrictEqual(texts(later), texts(base));
  assert.deepStrictEqual(texts(other), texts(base));
});

test("the same stepId with a different question shuffles differently — the answer does not sit in one slot across guides", () => {
  const base = new RetroGate(opts(clockAt(1_000)));
  const questions = [
    "What does the ledger book when a foreign ghost lands?",
    "Which side of the proof must ratify before an insert resolves?",
    "Why is the create walk absent for Python?",
    "When does a pure insert collide?",
    "What makes a rewrite beat a surgical edit here?",
  ];
  const orders = questions.map((question) => texts(new RetroGate(opts(clockAt(1_000), { question }))));
  assert.ok(
    orders.some((o) => JSON.stringify(o) !== JSON.stringify(texts(base))),
    "every question text produced the same order — the question is not part of the seed",
  );
  for (const o of orders) {
    assert.deepStrictEqual(o.slice().sort(), CHOICES.map((c) => c.text).sort(), "a reseeded order is still a permutation");
  }
});

test("different stepIds shuffle differently for at least one id — the step id is part of the seed", () => {
  const base = texts(new RetroGate(opts(clockAt(1_000))));
  const ids = ["1.1", "1.2", "2.1", "3.7", "10.4"];
  const orders = ids.map((stepId) => texts(new RetroGate(opts(clockAt(1_000), { stepId }))));
  assert.ok(
    orders.some((o) => JSON.stringify(o) !== JSON.stringify(base)),
    "every step id produced the same order — the id is not part of the seed",
  );
});

// --- 3. the honest developer ------------------------------------------------

test("picking the correct choice passes with no wrong picks and the clock's elapsed ms", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  clock.advance(2_400);
  const v = gate.pick(correctIndex(gate));
  assert.deepStrictEqual(v, { kind: "passed", wrongCount: 0, elapsedMs: 2_400 });
  assert.strictEqual(gate.passed, true);
  assert.strictEqual(gate.locked, false);
});

// --- 4. the wrong pick and its lockout --------------------------------------

test("a wrong pick reports its index, locks until now + lockoutMs, and counts one wrong", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  clock.advance(300);
  const bad = wrongIndices(gate)[0];
  const v = gate.pick(bad);
  assert.deepStrictEqual(v, { kind: "wrong", index: bad, lockoutUntil: 1_300 + LOCKOUT, wrongCount: 1 });
  assert.strictEqual(gate.wrongCount, 1);
  assert.strictEqual(gate.passed, false);
  assert.strictEqual(gate.locked, true);
});

test("the lockout counts down with the injected clock and is spent exactly at lockoutUntil", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  gate.pick(wrongIndices(gate)[0]);
  assert.strictEqual(gate.lockoutRemainingMs, LOCKOUT);
  clock.advance(2_000);
  assert.strictEqual(gate.lockoutRemainingMs, LOCKOUT - 2_000);
  assert.strictEqual(gate.locked, true);
  clock.advance(3_000); // now == lockoutUntil
  assert.strictEqual(gate.locked, false);
  assert.strictEqual(gate.lockoutRemainingMs, 0);
  clock.advance(10_000);
  assert.strictEqual(gate.lockoutRemainingMs, 0, "remaining never goes negative");
});

test("a wrong pick leaves survivors — the eliminated choice is no longer offered", () => {
  const gate = new RetroGate(opts(clockAt(1_000)));
  const bad = wrongIndices(gate)[0];
  gate.pick(bad);
  assert.deepStrictEqual(gate.survivors, [0, 1, 2].filter((i) => i !== bad));
});

// --- 5. accepts during the lockout are ignored (QuickPick still fires Enter) -

test("every pick during the lockout is ignored as locked and changes nothing — the correct one included", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  const [bad, other] = wrongIndices(gate);
  gate.pick(bad);
  const before = snap(gate);

  for (const i of [correctIndex(gate), other, bad]) {
    assert.deepStrictEqual(gate.pick(i), { kind: "ignored", reason: "locked" }, `pick(${i}) during lockout`);
  }
  assert.deepStrictEqual(snap(gate), before, "a locked pick moved the machine");
  assert.strictEqual(gate.passed, false, "the correct pick during a lockout must not pass the gate");
  assert.strictEqual(gate.wrongCount, 1, "a locked pick never adds a wrong");
});

test("a locked pick does not extend the lockout", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  gate.pick(wrongIndices(gate)[0]);
  clock.advance(2_000);
  gate.pick(correctIndex(gate));
  assert.strictEqual(gate.lockoutRemainingMs, LOCKOUT - 2_000);
  clock.advance(LOCKOUT - 2_000);
  assert.strictEqual(gate.locked, false);
});

// --- 6. the robot: two wrong picks, two lockouts, then the last one standing -

test("a second wrong pick after the lockout expires locks again and leaves only the correct choice", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  const [first, second] = wrongIndices(gate);
  const right = correctIndex(gate);

  gate.pick(first);
  clock.advance(LOCKOUT);
  assert.strictEqual(gate.locked, false);

  const v = gate.pick(second);
  assert.deepStrictEqual(v, { kind: "wrong", index: second, lockoutUntil: 1_000 + LOCKOUT * 2, wrongCount: 2 });
  assert.strictEqual(gate.locked, true, "the second wrong locks afresh");
  assert.deepStrictEqual(gate.survivors, [right], "only the correct choice is left standing");

  clock.advance(LOCKOUT);
  const passed = gate.pick(right);
  assert.deepStrictEqual(passed, { kind: "passed", wrongCount: 2, elapsedMs: LOCKOUT * 2 });
  assert.strictEqual(gate.passed, true);
});

// --- 7-9. the ignored verdicts ----------------------------------------------

test("re-picking an eliminated choice outside the lockout is ignored as eliminated and changes nothing", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  const bad = wrongIndices(gate)[0];
  gate.pick(bad);
  clock.advance(LOCKOUT);
  const before = snap(gate);
  assert.deepStrictEqual(gate.pick(bad), { kind: "ignored", reason: "eliminated" });
  assert.deepStrictEqual(snap(gate), before, "an eliminated re-pick moved the machine");
});

test("picking after the gate has passed is ignored as passed", () => {
  const gate = new RetroGate(opts(clockAt(1_000)));
  const right = correctIndex(gate);
  gate.pick(right);
  const before = snap(gate);
  assert.deepStrictEqual(gate.pick(right), { kind: "ignored", reason: "passed" });
  assert.deepStrictEqual(gate.pick(wrongIndices(gate)[0]), { kind: "ignored", reason: "passed" });
  assert.deepStrictEqual(snap(gate), before, "a post-pass pick moved the machine");
});

test("an out-of-range index is ignored, not a crash, and leaves the machine untouched", () => {
  const gate = new RetroGate(opts(clockAt(1_000)));
  const before = snap(gate);
  for (const i of [-1, 99]) {
    const v = gate.pick(i);
    assert.strictEqual(v.kind, "ignored", `pick(${i}) must be ignored`);
  }
  assert.deepStrictEqual(snap(gate), before, "an out-of-range pick moved the machine");
  // and the gate is still answerable afterwards
  assert.strictEqual(gate.pick(correctIndex(gate)).kind, "passed");
});

// --- 10-11. the window reload round trip ------------------------------------

const assertSameGate = (restored, original, label) => {
  assert.deepStrictEqual(texts(restored), texts(original), `${label}: order`);
  assert.deepStrictEqual(restored.survivors, original.survivors, `${label}: survivors`);
  assert.strictEqual(restored.wrongCount, original.wrongCount, `${label}: wrongCount`);
  assert.strictEqual(restored.passed, original.passed, `${label}: passed`);
  assert.strictEqual(restored.locked, original.locked, `${label}: locked`);
  assert.strictEqual(restored.lockoutRemainingMs, original.lockoutRemainingMs, `${label}: lockoutRemainingMs`);
};

test("serialize/restore round-trips a fresh gate — same shuffle, no wrong picks, never locked", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  const pending = gate.serialize();
  assert.strictEqual(pending.stepId, "2.3");
  assert.deepStrictEqual(pending.wrong, []);
  assert.strictEqual(pending.lockoutUntil, 0, "never locked serialises as 0");
  assert.strictEqual(pending.startedAt, 1_000);
  assertSameGate(RetroGate.restore(pending, opts(clock)), gate, "fresh");
});

test("serialize/restore round-trips a wrong pick mid-lockout — the reload stays locked for the remainder", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  gate.pick(wrongIndices(gate)[0]);
  clock.advance(2_000);

  const pending = gate.serialize();
  assert.deepStrictEqual(pending.wrong, [wrongIndices(gate)[0]], "the wrong pick persists by shuffled index");
  assert.strictEqual(pending.lockoutUntil, 1_000 + LOCKOUT);

  const restored = RetroGate.restore(pending, opts(clock));
  assertSameGate(restored, gate, "mid-lockout");
  assert.strictEqual(restored.locked, true);
  assert.strictEqual(restored.lockoutRemainingMs, LOCKOUT - 2_000);
  assert.deepStrictEqual(restored.pick(correctIndex(restored)), { kind: "ignored", reason: "locked" },
    "a reloaded gate honours the lockout it was serialised in");
});

test("serialize/restore round-trips a wrong pick whose lockout expired — the reload is answerable at once", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  gate.pick(wrongIndices(gate)[0]);
  clock.advance(LOCKOUT + 1);

  const restored = RetroGate.restore(gate.serialize(), opts(clock));
  assertSameGate(restored, gate, "expired");
  assert.strictEqual(restored.locked, false);
  assert.strictEqual(restored.lockoutRemainingMs, 0);
  assert.strictEqual(restored.pick(correctIndex(restored)).kind, "passed");
});

test("a restored gate keeps counting elapsed from the ORIGINAL startedAt, not from the reload", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  gate.pick(wrongIndices(gate)[0]);
  clock.advance(LOCKOUT); // the lockout is spent; the "reload" happens here

  const restored = RetroGate.restore(gate.serialize(), opts(clock));
  clock.advance(1_500);
  const v = restored.pick(correctIndex(restored));
  assert.deepStrictEqual(v, { kind: "passed", wrongCount: 1, elapsedMs: LOCKOUT + 1_500 });
});

test("a restored gate re-serialises to the same pending state — a reload loop cannot drift it", () => {
  const clock = clockAt(1_000);
  const gate = new RetroGate(opts(clock));
  gate.pick(wrongIndices(gate)[0]);
  clock.advance(1_000);

  const once = gate.serialize();
  const twice = RetroGate.restore(once, opts(clock)).serialize();
  assert.deepStrictEqual(twice, once);
});
