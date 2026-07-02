// Unit tests for soft anchor resolution on the modify path
// (src/disclosure/replay.ts `tryResolveOp`).
//
// The diff-replay controller re-anchors each remaining op against the live buffer
// before serving it. When the human's edit removes the very node an op targets — a
// structural collision — the strict `resolveOp` throws (it's the loud batch path).
// The interactive controller must instead SURFACE that (panel blocked, finish by
// hand), never crash the provider. `tryResolveOp` is the boundary: the live range,
// or null when the anchor is gone. These oracles pin the two outcomes:
//   - a benign live buffer (offsets shifted, structure intact) → resolves;
//   - a collided buffer (the targeted node deleted) → null, where resolveOp throws.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".collision.bundle.cjs");
const entry = path.join(__dirname, ".collision.entry.ts");
fs.writeFileSync(
  entry,
  `export { diffSymbols, parseRoot } from "../src/disclosure/diff";\n` +
    `export { resolveOp, tryResolveOp, resolveByContent, shiftWindow } from "../src/disclosure/replay";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { diffSymbols, parseRoot, resolveOp, tryResolveOp, resolveByContent, shiftWindow, buildReplaySteps } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

// A deep single change: `< now` -> `<= now` inside for>if>condition. The diff keeps
// it as one surgical op with a multi-level anchor path — exactly the case a
// structural edit can break.
const OLD = `fn must_fence(now: u64) -> bool {
    for peer in peers {
        if peer.expiry < now {
            return true;
        }
    }
    false
}
`;
const NEW = OLD.replace("< now", "<= now");

// The deepest op — the one with the most to lose if structure above it is edited.
const deepestOp = () => {
  const { ops } = diffSymbols(OLD, NEW);
  assert.ok(ops.length >= 1, "expected at least one op");
  return ops.slice().sort((a, b) => b.anchor.path.length - a.anchor.path.length)[0];
};

test("the change is a deep surgical op (multi-level anchor path)", () => {
  const op = deepestOp();
  assert.ok(op.anchor.path.length > 1, `expected a deep path, got [${op.anchor.path}]`);
});

test("tryResolveOp resolves against the intact live buffer", () => {
  const op = deepestOp();
  const r = tryResolveOp(parseRoot(OLD), op.anchor);
  assert.ok(Array.isArray(r), "intact buffer must resolve");
  assert.strictEqual(OLD.slice(r[0], r[1]), "peer.expiry < now", "range covers the targeted node");
});

test("tryResolveOp survives a benign shift (a hand-edit in a stable region)", () => {
  const op = deepestOp();
  // Rename an untouched statement — bytes move, the for>if structure is intact.
  const shifted = OLD.replace("false", "log(); false");
  const r = tryResolveOp(parseRoot(shifted), op.anchor);
  assert.ok(Array.isArray(r), "a benign shift must still resolve");
  assert.strictEqual(shifted.slice(r[0], r[1]), "peer.expiry < now");
});

test("tryResolveOp returns null on a structural collision (the loop deleted)", () => {
  const op = deepestOp();
  const collided = `fn must_fence(now: u64) -> bool {\n    false\n}\n`;
  assert.strictEqual(tryResolveOp(parseRoot(collided), op.anchor), null);
});

test("the strict resolveOp throws exactly where tryResolveOp returns null", () => {
  const op = deepestOp();
  const collided = `fn must_fence(now: u64) -> bool {\n    false\n}\n`;
  assert.throws(() => resolveOp(parseRoot(collided), op.anchor), /anchor path/);
});

// The controller's SECONDARY gate (the primary is "did the human edit this hunk's
// line"): while the buffer is mid-edit, an anchor break on an untouched hunk must
// HOLD, not alarm — the human is still typing. `root.hasError` is that signal, and
// it's reliable where a tryResolveOp break is not (tree-sitter's error recovery can
// resolve a half-typed line to a garbage range rather than null). A clean deletion
// parses without error, so a genuine structural collision still surfaces.
test("hasError marks a mid-edit buffer (hold) and not a clean deletion (surface)", () => {
  const op = deepestOp();

  // The human is mid-keystroke inside the condition — incomplete, invalid syntax.
  const midEdit = OLD.replace("if peer.expiry", "if a peer.expiry");
  assert.strictEqual(parseRoot(midEdit).hasError, true, "an incomplete edit parses with an error");

  // The loop is cleanly deleted — valid syntax, the node genuinely gone.
  const deleted = parseRoot(`fn must_fence(now: u64) -> bool {\n    false\n}\n`);
  assert.strictEqual(deleted.hasError, false, "a clean deletion parses without error");
  assert.strictEqual(tryResolveOp(deleted, op.anchor), null, "and the anchor is gone for good");
});

// The content-anchor fallback (src/disclosure/replay.ts `resolveByContent`, wired into
// the controller's resolveCurrent). The structural index path drifts to a valid-but-
// WRONG node when the human edits the op's own line — wrapping `peer.expiry < now` in
// `1 == 1 && …` shifts the named-child indices so the path resolves to `1 == 1`. The
// text the op replaces is stable across that wrap, so a unique-substring match re-
// locates the real span. These oracles pin the fallback and the drift it covers.

// The step carries the exact text it replaces, captured from the original buffer.
const firstStep = () => buildReplaySteps(OLD, NEW)[0];

test("resolveByContent finds a unique occurrence and refuses an ambiguous/absent one", () => {
  const buf = "alpha BETA gamma";
  assert.deepStrictEqual(resolveByContent(buf, "BETA"), [6, 10], "unique match returns its range");
  assert.strictEqual(buf.slice(6, 10), "BETA");
  assert.strictEqual(resolveByContent("x x", "x"), null, "two matches is ambiguous — null, never a guess");
  assert.strictEqual(resolveByContent(buf, "delta"), null, "absent text — null");
  assert.strictEqual(resolveByContent(buf, ""), null, "empty original (a pure insert) — nothing to match");
});

test("the step carries the exact original text it replaces", () => {
  const step = firstStep();
  assert.ok(step.originalText.length > 0, "a replace step has non-empty original text");
  assert.strictEqual(OLD.includes(step.originalText), true, "and it is real source from the original buffer");
});

test("on-line edit drifts the structural anchor to the WRONG node; content re-anchors correctly", () => {
  const step = firstStep();
  // The human wraps the condition: `if peer.expiry < now` -> `if 1 == 1 && peer.expiry < now`.
  const edited = OLD.replace("if peer.expiry < now", "if 1 == 1 && peer.expiry < now");
  assert.strictEqual(parseRoot(edited).hasError, false, "the wrapped condition still parses clean");

  // Structural alone now resolves the index path to a valid-but-wrong span (the `1 == 1`
  // the human just typed), NOT the text the op meant to replace.
  const structural = tryResolveOp(parseRoot(edited), step.anchor);
  assert.ok(structural, "the path still resolves (to a node) — it just drifted");
  assert.notStrictEqual(
    edited.slice(structural[0], structural[1]),
    step.originalText,
    "structural drift: the range no longer covers the op's text — serving it would clobber the edit",
  );

  // The controller's rule: trust structural only when its range still matches; else
  // fall back to content. The fallback lands on the right span, preserving the edit.
  const r = resolveByContent(edited, step.originalText);
  assert.ok(r, "content re-anchors on the still-present original text");
  assert.strictEqual(edited.slice(r[0], r[1]), step.originalText, "and on the RIGHT span, not the `1 == 1`");
});

test("a genuine structural collision (the op's text gone) still yields null from both paths", () => {
  const step = firstStep();
  const rewritten = OLD.replace("peer.expiry < now", "peer.is_stale()"); // the op's text no longer exists
  assert.strictEqual(resolveByContent(rewritten, step.originalText), null, "content has nothing to match");
});

// The symbol window must absorb the human's keystrokes (src/disclosure/replay.ts
// `shiftWindow`, wired into the controller's noteChange). The controller re-parses
// `buffer.slice(anchorOffset, anchorOffset + symbolLen)` each step; it only books its
// OWN swaps into symbolLen, so a human keystroke is otherwise invisible and the window
// drifts. Even one byte short truncates the closing brace — the re-parse errors and the
// re-anchor holds forever (the "even a space breaks it" bug). These pin the arithmetic.
const win = (anchorOffset, symbolLen) => ({ anchorOffset, symbolLen });

test("shiftWindow grows/shrinks for an edit inside, shifts for one before, ignores one after", () => {
  const w = win(10, 20); // symbol occupies [10, 30)
  // insert 3 chars at offset 15 (inside): symbolLen +3, anchor unchanged
  assert.deepStrictEqual(shiftWindow(w, { rangeOffset: 15, rangeLength: 0, textLength: 3 }), win(10, 23));
  // delete 4 chars at offset 12 (inside): symbolLen -4
  assert.deepStrictEqual(shiftWindow(w, { rangeOffset: 12, rangeLength: 4, textLength: 0 }), win(10, 16));
  // insert 5 chars at offset 2 (before the symbol): anchor +5, symbolLen unchanged
  assert.deepStrictEqual(shiftWindow(w, { rangeOffset: 2, rangeLength: 0, textLength: 5 }), win(15, 20));
  // edit entirely after the symbol (offset 40): both unchanged
  assert.deepStrictEqual(shiftWindow(w, { rangeOffset: 40, rangeLength: 0, textLength: 9 }), win(10, 20));
});

test("regression: a one-char insert keeps the window covering the WHOLE symbol (not truncated)", () => {
  // Seed the symbol at offset 0, as the controller does, then type a space mid-symbol.
  let buffer = OLD;
  let w = win(0, OLD.length);
  const at = buffer.indexOf("peer.expiry");
  buffer = buffer.slice(0, at) + " " + buffer.slice(at); // human inserts one space
  w = shiftWindow(w, { rangeOffset: at, rangeLength: 0, textLength: 1 });

  const symText = buffer.slice(w.anchorOffset, w.anchorOffset + w.symbolLen);
  assert.strictEqual(symText, buffer, "the window still covers the full (grown) symbol");
  assert.strictEqual(parseRoot(symText).hasError, false, "so the re-parse is clean — not a truncated brace");
  // and the op re-anchors on the live buffer (the space didn't change the structure)
  const step = firstStep();
  const sr = tryResolveOp(parseRoot(symText), step.anchor);
  const r = sr && symText.slice(sr[0], sr[1]) === step.originalText ? sr : resolveByContent(symText, step.originalText);
  assert.ok(r && symText.slice(r[0], r[1]) === step.originalText, "the ghost re-anchors after the keystroke");
});
