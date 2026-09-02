// Oracles for the two decisions the whole gate turns on, neither of which the
// parser oracle or the state-machine oracle covers.
//
// First: `gates()`. The parser stores an answer key whenever the guide wrote
// one; `gates()` decides whether that key becomes a gate. Every other test in
// this repo asserts on the parse, so flipping `gates()` to a bare
// `choices.length === 3` used to leave the suite green while every `none` step
// in every guide started gating. This file is what goes red instead.
//
// Second: the shuffle's answer SLOT. `gate.test.cjs` proves the order changes
// with the seed, which a shuffle that pins the answer to slot 0 and permutes
// only the two distractors also satisfies. That shuffle is exactly the leak the
// seeding rule exists to close: a human who meets it twice stops reading.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".retro-gating.bundle.cjs");
const entry = path.join(__dirname, ".retro-gating.entry.ts");
fs.writeFileSync(
  entry,
  `export { gates, isWeak, isNoneQuestion } from "../src/retrospective/retrospective";\n` +
    `export { RetroGate } from "../src/retrospective/gate";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
});
const { gates, RetroGate } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const CHOICES = [
  { text: "It only masks bits off, which never increases the value.", correct: true },
  { text: "Bitwise ops are exempt from debug overflow checks.", correct: false },
  { text: "It takes a `u32`, so the sum cannot reach `u64::MAX`.", correct: false },
];
const SPECIFIC = "Why can `align_down` never overflow where `align_up` can?";
const retro = (question, choices = CHOICES) => ({ symbol: "x", question, why: "w", invariants: [], choices });

const GATING = [
  { name: "a specific question with an answer and two distractors", retro: retro(SPECIFIC), gates: true },
  { name: "no answer key at all", retro: retro(SPECIFIC, []), gates: false },
  { name: "a `none` question, however it is cased or continued", retro: retro("None — trivial rename"), gates: false },
  { name: "a bare `none` question", retro: retro("none"), gates: false },
  { name: "a weak question (the smell is on the guide's author)", retro: retro("Does this make sense?"), gates: false },
  { name: "an answer key with no question to ask", retro: retro("   "), gates: false },
];

for (const c of GATING) {
  test(`gates(): ${c.name} ${c.gates ? "gates" : "does not gate"}`, () => {
    assert.strictEqual(gates(c.retro), c.gates);
  });
}

test("gates() is not a synonym for three choices", () => {
  // The whole point of the function. Every row here carries a full answer key.
  const refused = GATING.filter((c) => !c.gates && c.retro.choices.length === 3);
  assert.ok(refused.length >= 3, "the table must cover the refusals, not just the pass");
  for (const c of refused) {
    assert.strictEqual(gates(c.retro), false, `three choices alone must not gate: ${c.name}`);
  }
});

// A shuffle that moves the distractors but leaves the answer put would satisfy
// "the order changes with the seed" and still teach the human to press the same
// key every time. Assert on where the ANSWER lands.
test("the answer lands in every slot across steps, not just a different order", () => {
  const slots = [0, 0, 0];
  const questions = [
    SPECIFIC,
    "What happens to the lease if the clock drifts past the TTL?",
    "Why does `flush` take the write lock before it reads the tail?",
    "Which peer wins when two proposals carry the same term?",
    "Where does the retry budget come from if the caller set none?",
  ];
  for (let major = 1; major <= 12; major++) {
    for (let minor = 1; minor <= 4; minor++) {
      for (const question of questions) {
        const gate = new RetroGate({
          stepId: `${major}.${minor}`,
          question,
          choices: CHOICES,
          lockoutMs: 0,
          now: () => 0,
        });
        slots[gate.order.findIndex((c) => c.correct)]++;
      }
    }
  }
  const total = slots.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 12 * 4 * questions.length);
  for (const [at, count] of slots.entries()) {
    // Loose on purpose: this is a leak check, not a randomness proof. A shuffle
    // that pins the answer anywhere scores 0 in two of these.
    assert.ok(
      count / total > 0.2,
      `the answer lands in slot ${at} only ${((count / total) * 100).toFixed(1)}% of the time — the picker has a tell`,
    );
  }
});
