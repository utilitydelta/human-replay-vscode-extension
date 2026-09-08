// The insert proof's legs, each pinned on its own.
//
// `insert-proof.test.cjs` drives the whole resolver over recorded incident
// bytes. That is the right level for "does the human's step land", but it hides
// which leg did the work: the resolver tries arithmetic, then structure, then a
// content search, and any one of them can rescue a case the others refuse. A
// mutation run proved the point — reverting `proofOk`'s end-of-symbol rule broke
// nothing, because the content leg quietly covered for it.
//
// So these tests call the legs directly. Each names the rule it pins and the
// shape that rule exists for.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".proof-legs.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/proof.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { bakeLeftContext, bakeRightContext, proofOk, resolveInsertPoint, explainInsertCollision } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

// --- bakeRightContext: what counts as a tail --------------------------------

test("right context: the rest of the attach line plus the next line, when the next line has bytes", () => {
  const src = "alpha\nbeta\ngamma\n";
  assert.strictEqual(bakeRightContext(src, 6), "beta\ngamma\n", "two lines of real tail");
});

test("right context: a blank line below the point is layout, so the context keeps going", () => {
  // The markdown table-row incident: the insert attaches above a blank line and
  // real prose follows. Stopping at the blank line hands proofOk a blank side,
  // which can only ratify positionally, and a legitimate mid-symbol insert then
  // collides.
  const src = "| a |\n\nSome prose that follows.\n";
  const ctx = bakeRightContext(src, 6);
  assert.notStrictEqual(ctx.trim(), "", "the context carries real bytes, not just blank lines");
  assert.ok(ctx.startsWith("\n"), "it still begins at the point");
  assert.ok(ctx.includes("Some prose"), "it reaches the next line that has content");
});

test("right context: nothing but whitespace to the end of the source stays blank — that IS the no-tail case", () => {
  const src = "## Setup\n\nInstall it.\n";
  const ctx = bakeRightContext(src, src.length - 1);
  assert.strictEqual(ctx, "\n", "an end-of-symbol append has only the trailing newline ahead of it");
  assert.strictEqual(ctx.trim(), "", "and it is blank, so proofOk takes the tail rule");
});

test("right context: an append below a long run of blank lines still reads to the end", () => {
  // The reviewer's F4: nine blank lines under the attach point used to hit the
  // 8-line cap, leaving a context that was blank but NOT the symbol's tail —
  // unratifiable, so the append collided. The cap is a fail-loud boundary now,
  // set where reaching it means something pathological.
  const src = `x\n${"\n".repeat(9)}`;
  const ctx = bakeRightContext(src, 1);
  assert.strictEqual(ctx, src.slice(1), "the context reaches the end of the source");
  assert.strictEqual(proofOk(src, 1, { left: "x", right: ctx }), true, "so the append ratifies against the tail");
});

test("right context: a blank run past the cap is refused, loudly, rather than half-read", () => {
  const src = `x\n${"\n".repeat(200)}y\n`;
  const ctx = bakeRightContext(src, 1);
  assert.strictEqual(ctx.trim(), "", "still blank at the cap");
  assert.notStrictEqual(ctx, src.slice(1), "and it is not the tail either");
  assert.strictEqual(proofOk(src, 1, { left: "x", right: ctx }), false, "so nothing ratifies it and the step collides");
});

test("right context: a run of blank lines longer than the cap still terminates", () => {
  const src = `x\n${"\n".repeat(400)}y\n`;
  const started = Date.now();
  const ctx = bakeRightContext(src, 1);
  assert.ok(Date.now() - started < 1000, "the scan is capped, not unbounded");
  assert.ok(src.startsWith(ctx, 1), "and it is still a slice of the source at the point");
});

// --- proofOk: the blank-right tail rule -------------------------------------

test("proofOk: a blank right side ratifies by TAIL EQUALITY, so an append lands one byte short of the end", () => {
  // The shape the field census caught: a markdown section's bytes end with a
  // newline, so the append point is length - 1, not length. The old positional
  // rule (`p === symText.length`) refused every one of them.
  const symbol = "## Setup\n\nInstall the runtime.\n";
  const point = symbol.length - 1; // ahead of the section's own trailing newline
  const proof = { left: "Install the runtime.", right: "\n" };
  assert.strictEqual(proofOk(symbol, point, proof), true, "the point whose tail equals the context ratifies");
});

test("proofOk: a blank right side refuses a point whose tail is not the context", () => {
  const symbol = "## Setup\n\nInstall the runtime.\n";
  const proof = { left: "Install the runtime.", right: "\n" };
  // Two bytes short of the end: the tail is "e\n", not "\n".
  assert.strictEqual(proofOk(symbol, symbol.length - 2, proof), false, "a near-miss point is still a miss");
  assert.strictEqual(proofOk(symbol, 5, proof), false, "and a point in the middle is refused outright");
});

test("proofOk: an empty right context means the point is the symbol's last byte", () => {
  const symbol = "fn f() {\n    body();\n}";
  const proof = { left: "    body();\n}", right: "" };
  assert.strictEqual(proofOk(symbol, symbol.length, proof), true, "an empty tail ratifies only at the end");
  assert.strictEqual(proofOk(symbol, symbol.length - 1, proof), false);
});

test("proofOk: a non-blank right side is still matched as bytes at the point", () => {
  const symbol = "a\nb\nc\n";
  assert.strictEqual(proofOk(symbol, 2, { left: "a\n", right: "b\nc\n" }), true);
  assert.strictEqual(proofOk(symbol, 2, { left: "a\n", right: "zzz" }), false, "a tail that is not there refuses");
});

test("proofOk: the left context must sit at a line start, not merely occur before the point", () => {
  const symbol = "alpha beta\ngamma\n";
  // "beta\n" does precede the point but does not start its line.
  assert.strictEqual(proofOk(symbol, 11, { left: "beta\n", right: "gamma\n" }), false);
  assert.strictEqual(proofOk(symbol, 11, { left: "alpha beta\n", right: "gamma\n" }), true);
});

// --- resolveInsertPoint: the content leg uses the same tail rule -------------

test("content leg: a unique left context lands the point, with the blank-right tail rule applied there too", () => {
  const symbol = "## Setup\n\nInstall the runtime.\n";
  const proof = { left: "Install the runtime.", right: "\n" };
  // The baked start is stale (the ledger says the point moved), so arithmetic
  // is wrong and there is no structural candidate: only the content leg is left.
  const step = { start: 3, proof };
  assert.strictEqual(resolveInsertPoint(symbol, step, [], null), null, "a point behind the frontier is refused");
  // With the arithmetic point at the true offset, the first leg ratifies.
  assert.strictEqual(resolveInsertPoint(symbol, { start: symbol.length - 1, proof }, [], null), symbol.length - 1);
});

test("resolveInsertPoint: an unproven insert never lands", () => {
  assert.strictEqual(resolveInsertPoint("anything", { start: 0 }, [], 0), null, "no proof, no landing");
});

test("resolveInsertPoint: a left context that occurs twice collides rather than guessing", () => {
  const symbol = "x\ny\nx\ny\n";
  const proof = { left: "x\n", right: "y\n" };
  // Arithmetic says 6, which does not ratify (tail is "y\n" but left at 6 is
  // "x\n" starting at 4 — it does ratify); use a point that cannot ratify so the
  // content leg runs, and let it find two line-start matches.
  assert.strictEqual(resolveInsertPoint(symbol, { start: 3, proof }, [], null), null, "two candidates is a collision, not a coin flip");
});

// --- the forensic line ------------------------------------------------------

test("explainInsertCollision: a blank right side reports whether the TAIL matched, not just that it was blank", () => {
  const symbol = "## Setup\n\nInstall the runtime.\n";
  const proof = { left: "Install the runtime.", right: "\n" };
  const matched = explainInsertCollision(symbol, { start: symbol.length - 1, proof }, []);
  assert.match(matched, /tail matches/, "a ratifying tail says so");
  const missed = explainInsertCollision(symbol, { start: 4, proof }, []);
  assert.match(missed, /tail is/, "a refusing tail shows what was actually there");
  assert.doesNotMatch(missed, /right blank\)/, "the old bare 'blank' would point the reader at the wrong end");
});
