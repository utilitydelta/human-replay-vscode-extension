// Unit tests for the model-free actionability filter (src/disclosure/actionability.ts).
//
// S10 proved the model fabricates on vague/noise input regardless of prompting, so the
// real gate is this upstream filter. These oracles pin it against the exact held-out
// texts S10 validated on (spikes/S10-comment-prompt/holdout.js): the all-vague sets
// (compactor "could be better", router "messy/tidy", "lol classic") must read as a
// smell; clear comments and conflicting pairs must pass through.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".actionability.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/actionability.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
});
const { isActionable, setIsActionable } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

// Vague / noise — must read as NOT actionable (the cases the model fabricates on).
const VAGUE = [
  "hmm not sure about this one, could probably be better",
  "this is kinda messy tbh, tidy it",
  "lol classic",
  "idk, this feels off. clean it up?",
  "looks wrong",
];

// Clear, actionable comments — must pass.
const ACTIONABLE = [
  "guard against b == 0 — return a Result instead of panicking",
  "add a 5s connect timeout so a dead peer can't hang us forever",
  "this races under clock skew — need a grace band so the boundary is asymmetric",
  "if now < start this underflows and panics — use a saturating duration",
  "don't return a Vec, stream it as an iterator so the caller pulls lazily",
  "`d` is a terrible name — call it `backoff`",
];

for (const t of VAGUE) {
  test(`vague is a smell: ${JSON.stringify(t.slice(0, 32))}`, () => {
    assert.strictEqual(isActionable(t), false);
  });
}

for (const t of ACTIONABLE) {
  test(`actionable passes: ${JSON.stringify(t.slice(0, 32))}`, () => {
    assert.strictEqual(isActionable(t), true);
  });
}

test("set gate: an all-vague note set is blocked", () => {
  assert.strictEqual(setIsActionable(["could probably be better"]), false);
  assert.strictEqual(setIsActionable(["lol classic"]), false);
});

test("set gate: a conflicting pair passes (each side is a real constraint)", () => {
  // The model flags the conflict correctly (S10); the filter must not eat it.
  const conflict = [
    "add a TTL so stale entries expire after 60s",
    "no — audit requires entries live forever, they must never expire",
  ];
  assert.strictEqual(setIsActionable(conflict), true);
});

test("set gate: one actionable note among vague ones still passes", () => {
  assert.strictEqual(
    setIsActionable(["lol classic", "guard against b == 0, return a Result"]),
    true,
  );
});
