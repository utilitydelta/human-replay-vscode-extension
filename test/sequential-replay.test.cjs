// Unit tests for SEQUENTIAL re-anchored replay (the live controller's loop).
//
// replayLive (covered in replay.test.cjs) resolves every op against ONE parse of
// the buffer, then applies them by offset. The live diff-replay controller does
// not: it re-resolves each step against the buffer AS MUTATED by the prior accept,
// re-parsing between steps. That step-by-step loop is what runs at the keyboard,
// and it was only proven in batch — a coverage gap. These oracles close it.
//
// The invariant: re-resolving each hunk against the freshly-parsed live buffer
// (offsets already shifted by earlier accepts) still lands byte-exact, because the
// anchor is structural (a named-child path), not an absolute offset. And it holds
// after a benign hand-edit in a stable region — the reason re-anchoring exists.
//
// Scope: multi-hunk replacements, plus the controller-policy section at the
// bottom covering sibling-index shifts from the walk's own accepts (an added
// comment line renumbers later anchor paths) — arithmetic-first resolveStep.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".seqreplay.bundle.cjs");
const entry = path.join(__dirname, ".seqreplay.entry.ts");
fs.writeFileSync(
  entry,
  `export { diffSymbols, parseRoot } from "../src/disclosure/diff";\n` +
    `export { resolveOp, replayLive, resolveStep } from "../src/disclosure/replay";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown"],
});
const { diffSymbols, parseRoot, resolveOp, replayLive, resolveStep, buildReplaySteps } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

// Faithful step-by-step replay: re-parse the live buffer, re-resolve every
// remaining op against it, apply the leftmost, repeat. Each op is resolved AFTER
// the prior accept mutated the buffer — exactly the controller's loop, and what
// the batch path never exercises.
function replaySequential(buffer, ops) {
  let buf = buffer;
  let remaining = [...ops];
  let guard = 0;
  while (remaining.length) {
    if (guard++ > 100) throw new Error("sequential replay did not converge");
    const root = parseRoot(buf);
    const resolved = remaining.map((op, i) => {
      const [start, end] = resolveOp(root, op.anchor);
      return { op, i, start, end };
    });
    resolved.sort((a, b) => a.start - b.start || a.end - b.end);
    const next = resolved[0];
    buf = buf.slice(0, next.start) + next.op.replacement + buf.slice(next.end);
    remaining.splice(next.i, 1);
  }
  return buf;
}

// Multi-hunk replacement corpus: changes separated by a stable region so the diff
// keeps them as distinct ops (verified — each yields >= 2 ops). `perturb` is a
// hand-edit applied to BOTH sides in a region neither op touches.
const CORPUS = [
  {
    name: "two flat let-hunks across a stable middle statement",
    old: `fn calc() -> i32 {\n    let x = 1;\n    let stable = 99;\n    let y = 2;\n    x + stable + y\n}\n`,
    new: `fn calc() -> i32 {\n    let x = 11;\n    let stable = 99;\n    let y = 22;\n    x + stable + y\n}\n`,
    perturb: ["let stable = 99;", "let stable = compute_stable();"],
  },
  {
    name: "two nested if-condition hunks (deep paths) across a stable statement",
    old: `fn check(now: u64) -> bool {\n    let mut hit = false;\n    if a < now {\n        hit = true;\n    }\n    let pad = 0;\n    if b < now {\n        hit = true;\n    }\n    hit\n}\n`,
    new: `fn check(now: u64) -> bool {\n    let mut hit = false;\n    if a <= now {\n        hit = true;\n    }\n    let pad = 0;\n    if b <= now {\n        hit = true;\n    }\n    hit\n}\n`,
    perturb: ["let pad = 0;", "let pad = padding();"],
  },
];

const once = (s, find, repl) => {
  const i = s.indexOf(find);
  assert.notStrictEqual(i, -1, `perturb target ${JSON.stringify(find)} must exist`);
  return s.slice(0, i) + repl + s.slice(i + find.length);
};

for (const { name, old: oSrc, new: nSrc, perturb } of CORPUS) {
  test(`${name}: the pair is genuinely multi-hunk (>= 2 ops)`, () => {
    const { ops } = diffSymbols(oSrc, nSrc);
    assert.ok(ops.length >= 2, `expected >=2 ops, got ${ops.length}`);
  });

  test(`${name}: step-by-step re-anchor rebuilds the new symbol byte-exact`, () => {
    const { ops } = diffSymbols(oSrc, nSrc);
    assert.strictEqual(replaySequential(oSrc, ops), nSrc);
  });

  test(`${name}: sequential agrees with batch (re-parse between steps changes nothing)`, () => {
    const { ops } = diffSymbols(oSrc, nSrc);
    assert.strictEqual(replaySequential(oSrc, ops), replayLive(oSrc, ops));
  });

  test(`${name}: survives a benign divergence in a stable region`, () => {
    const { ops } = diffSymbols(oSrc, nSrc);
    const divergedOld = once(oSrc, perturb[0], perturb[1]);
    const divergedNew = once(nSrc, perturb[0], perturb[1]);
    assert.notStrictEqual(divergedOld, oSrc, "perturbation must change old");
    assert.strictEqual(
      replaySequential(divergedOld, ops),
      divergedNew,
      "re-anchored steps must rebuild the diverged new byte-exact",
    );
  });
}

// --- controller policy: arithmetic-first resolveStep -------------------------
// An accept that ADDS a named sibling (a doc-comment line, a new statement)
// renumbers every structural index path after it, so anchor-only sequential
// replay collides on the next op — the first dogfood run hit exactly this
// (follower-commit 1.1: comment reword + comment line insert, then the arg
// insert's anchor resolved null and its content match `,\n    ` was ambiguous).
// The controller resolves arithmetic-first: baked range + the running delta of
// its OWN accepts, trusted only when the live bytes equal originalText. These
// oracles replay the controller's exact loop and pin: byte-exact end state, and
// no null resolution mid-walk (the collision the user saw).

function replayControllerPolicy(buffer, steps) {
  let buf = buffer;
  let selfDelta = 0;
  for (const [i, st] of steps.entries()) {
    const root = parseRoot(buf);
    const r = resolveStep(buf, root, st, selfDelta);
    assert.ok(r, `step ${i} must resolve (collision = the surfaced modal)`);
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
  }
  return buf;
}

const SIBLING_SHIFT_CORPUS = [
  {
    // The follower-commit 1.1 shape: reworded doc comment that GAINS a line
    // (sibling insert at the symbol root), then an edit deeper in the fn whose
    // separator content (",\n        ") is ambiguous everywhere.
    name: "doc-comment gains a line, then a call-argument insert",
    old: `/// Simulates the non-leader path: queue → sync.\nfn helper(a: u64) {\n    commit(\n        a,\n        b,\n        c,\n    );\n}\n`,
    new: `/// Simulates the immediate non-leader path (standalone):\n/// queue → sync, read = write applied immediately.\nfn helper(a: u64) {\n    commit(\n        a,\n        CommitTarget::Immediate,\n        b,\n        c,\n    );\n}\n`,
  },
  {
    // Statement inserted early in the body shifts the sibling indices of every
    // later statement the remaining ops anchor through.
    name: "new first statement, then a change in a later statement",
    old: `fn run(now: u64) {\n    let a = fetch(now);\n    apply(a, now);\n}\n`,
    new: `fn run(now: u64) {\n    let guard = lease(now);\n    let a = fetch(now);\n    apply(a, guard);\n}\n`,
  },
];

for (const { name, old: oSrc, new: nSrc } of SIBLING_SHIFT_CORPUS) {
  test(`${name}: controller-policy sequential replay is byte-exact (no collision)`, () => {
    const steps = buildReplaySteps(oSrc, nSrc);
    assert.ok(steps.length >= 2, `expected >=2 steps, got ${steps.length}`);
    assert.strictEqual(replayControllerPolicy(oSrc, steps), nSrc);
  });
}

test("resolveStep: human edit before the op defeats arithmetic, structure still lands it", () => {
  const oSrc = `fn calc() -> i32 {\n    let x = 1;\n    let stable = 99;\n    x + stable\n}\n`;
  const nSrc = `fn calc() -> i32 {\n    let x = 1;\n    let stable = 99;\n    x + stable + 1\n}\n`;
  const steps = buildReplaySteps(oSrc, nSrc);
  assert.strictEqual(steps.length, 1);
  // A hand edit ABOVE the op shifts the bytes without touching structure: the
  // arithmetic byte-check must fail closed and the structural anchor take over.
  const edited = oSrc.replace("let x = 1;", "let x = 100;");
  const r = resolveStep(edited, parseRoot(edited), steps[0], 0);
  assert.ok(r, "structural fallback must resolve");
  assert.strictEqual(edited.slice(r[0], r[1]), steps[0].originalText);
});
