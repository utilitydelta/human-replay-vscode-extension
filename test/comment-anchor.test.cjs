// Unit tests for semantic comment anchoring (src/disclosure/commentAnchor.ts).
//
// A replay note pinned at a bare line drifts when the human edits above it. The
// structural anchor must instead *ride* the shift: re-resolving against the live
// buffer returns the note's node at its new line. These oracles pin that — on the
// un-shifted buffer the line is unchanged; after lines are inserted above, the
// note tracks its node; and a broken path degrades to a snippet search, then to
// the captured line, so a note never resolves to nowhere.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".commentanchor.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/commentAnchor.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust"],
});
const { anchorAt, resolveAnchorLine } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

const SRC = `fn must_fence(now: u64) -> bool {
    let mut hit = false;
    for peer in peers {
        if peer.expiry < now {
            hit = true;
        }
    }
    hit
}
`;
const IF_LINE = 3; // "        if peer.expiry < now {"

test("anchor captures a non-empty structural path", () => {
  const a = anchorAt(SRC, IF_LINE);
  assert.ok(a, "should anchor");
  assert.ok(a.path.length > 0, "path must descend below the root");
  assert.match(a.snippet, /if peer\.expiry < now/);
  assert.strictEqual(a.line, IF_LINE);
});

test("un-shifted buffer: re-resolve returns the original line", () => {
  const a = anchorAt(SRC, IF_LINE);
  assert.strictEqual(resolveAnchorLine(SRC, a), IF_LINE);
});

test("lines inserted above: the note rides the shift to the new line", () => {
  const a = anchorAt(SRC, IF_LINE);
  // Two new statements land above the for-loop the note is inside.
  const shifted = SRC.replace(
    "    let mut hit = false;\n",
    "    let mut hit = false;\n    let extra = warm_up();\n    let more = prepare();\n",
  );
  assert.strictEqual(resolveAnchorLine(shifted, a), IF_LINE + 2);
});

test("lines removed above: the note rides the shift upward", () => {
  const a = anchorAt(SRC, IF_LINE);
  const shifted = SRC.replace("    let mut hit = false;\n", "");
  assert.strictEqual(resolveAnchorLine(shifted, a), IF_LINE - 1);
});

test("broken path falls back to the snippet's current line", () => {
  const a = anchorAt(SRC, IF_LINE);
  // Restructure so the named-child path no longer reaches the same node, but the
  // text the note was about still exists — the snippet fallback must find it.
  const restructured = `fn must_fence(now: u64) -> bool {
    let extra_block = { 1 };
    let another = { 2 };
    while running {
        if peer.expiry < now {
            hit = true;
        }
    }
    hit
}
`;
  const line = resolveAnchorLine(restructured, a);
  assert.match(restructured.split("\n")[line], /if peer\.expiry < now/);
});

test("snippet gone entirely: last-resort fallback is the captured line", () => {
  const a = anchorAt(SRC, IF_LINE);
  const gone = `fn unrelated() {\n    let x = 1;\n}\n`;
  assert.strictEqual(resolveAnchorLine(gone, a), a.line);
});

test("a line outside the buffer does not anchor", () => {
  assert.strictEqual(anchorAt(SRC, 9999), null);
});
