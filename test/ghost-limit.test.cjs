// Oracle for VS Code's ghost-size limit (src/disclosure/walk.ts GHOST_MAX_CHARS).
//
// VS Code silently draws nothing for an inline completion over 5000 chars. The
// live incident: step 18/29 of a create walk was one 106-line `scanner.scan(..)`
// statement, 5765 chars, served and never drawn, and every Tab after it was
// dead. The corpus is that function, byte for byte. The walk now cuts such a
// node into consecutive pieces; these tests prove no served ghost is over the
// limit, the pieces still rebuild the source byte-exact, and recovery treats a
// split node as one node.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".ghost-limit.bundle.cjs");
const entry = path.join(__dirname, ".ghost-limit.entry.ts");
fs.writeFileSync(
  entry,
  `export { computeSteps, walkableSource, splitForGhost, GHOST_MAX_CHARS } from "../src/disclosure/walk";\n` +
    `export { DisclosureSession } from "../src/disclosure/session";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["vscode", "tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { computeSteps, walkableSource, splitForGhost, GHOST_MAX_CHARS, DisclosureSession } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const incident = fs.readFileSync(path.join(__dirname, "corpus/field-rs-oversized-leaf.rs"), "utf8");

// A synthetic node over the limit: a fn whose one statement is a long chain.
const longChain =
  "fn build() {\n    let v = source\n" +
  Array.from({ length: 200 }, (_, i) => `        .map(|x| x + ${i}) // step ${i} of a long pipeline\n`).join("") +
  "        .collect::<Vec<_>>();\n    v\n}";

const corpora = [
  ["incident: the 5765-char scan statement", incident],
  ["synthetic: a 200-link method chain", longChain],
];

const replay = (steps) => {
  let buf = "";
  for (const s of steps) {
    buf = buf.slice(0, s.insertOffset) + s.insert + buf.slice(s.insertOffset);
  }
  return buf;
};

for (const [name, src] of corpora) {
  test(`${name}: the corpus really carries a node over the limit`, () => {
    const steps = computeSteps(src);
    assert.ok(steps.some((s) => s.continuation), "no split happened — the corpus no longer exercises the limit");
  });

  test(`${name}: no served ghost is over VS Code's limit`, () => {
    for (const [i, s] of computeSteps(src).entries()) {
      assert.ok(s.insert.length <= GHOST_MAX_CHARS, `step ${i + 1} is ${s.insert.length} chars`);
    }
  });

  test(`${name}: the pieces rebuild the source byte-exact`, () => {
    assert.strictEqual(replay(computeSteps(src)), src);
    assert.ok(walkableSource(src), "walkableSource rejected a split walk");
  });

  test(`${name}: each piece inserts where the previous cursor landed`, () => {
    const steps = computeSteps(src);
    for (let i = 1; i < steps.length; i++) {
      assert.strictEqual(steps[i].insertOffset, steps[i - 1].cursorOffset, `step ${i + 1}`);
    }
  });

  test(`${name}: a continuation piece never leads with indentation`, () => {
    // VS Code gates Tab-commit on the ghost's leading indentation.
    for (const s of computeSteps(src).filter((s) => s.continuation)) {
      assert.ok(!/^[ \t]/.test(s.insert), `piece leads with whitespace: ${JSON.stringify(s.insert.slice(0, 20))}`);
    }
  });

  test(`${name}: a split node's first piece carries the whole node for recovery`, () => {
    const steps = computeSteps(src);
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].continuation || !steps[i + 1]?.continuation) continue;
      let whole = steps[i].insert;
      for (let k = i + 1; steps[k]?.continuation; k++) whole += steps[k].insert;
      assert.ok(whole.includes(steps[i].bareText.split("\n")[0]), "head bareText is not this node");
      assert.ok(steps[i].bareText.split("\n").length === whole.trimStart().split("\n").length, "head bareText is not the whole node");
    }
  });

  test(`${name}: recovery steps over a split node's continuation pieces`, () => {
    const steps = computeSteps(src);
    const head = steps.findIndex((s, i) => !s.continuation && steps[i + 1]?.continuation);
    const session = new DisclosureSession({}, 0, steps, src.length);
    session.index = head;
    session.advancePastNode();
    assert.ok(!session.current()?.continuation, "recovery would land a continuation piece as a node");
    assert.ok(session.index > head + 1);
  });
}

test("the incident statement splits into two even halves, not 5000 + a stub", () => {
  const pieces = computeSteps(incident).filter((s, i, all) => s.continuation || all[i + 1]?.continuation);
  assert.strictEqual(pieces.length, 2);
  assert.ok(pieces.every((p) => p.insert.length < 3500), pieces.map((p) => p.insert.length).join(", "));
});

// splitForGhost over shapes the walk can hand it, including ones with no
// newline to cut at.
const splitCases = [
  ["short text is untouched", "fn a() {}", 5000],
  ["many lines", Array.from({ length: 900 }, (_, i) => `    line ${i}`).join("\n"), 5000],
  ["one line longer than the limit", "x".repeat(12001), 5000],
  ["long line of spaced words", "word ".repeat(3000), 5000],
  ["astral chars across a hard cut", "😀".repeat(4000), 5000],
  ["leading newlines only", "\n".repeat(20) + "y".repeat(90), 40],
  ["small max, mixed lines", "ab\n    cd\n\n  ef gh ij\nkl", 5],
];

for (const [name, text, max] of splitCases) {
  test(`splitForGhost: ${name}`, () => {
    const pieces = splitForGhost(text, max);
    assert.strictEqual(pieces.join(""), text, "pieces do not rebuild the text");
    for (const p of pieces) {
      assert.ok(p.length > 0, "empty piece");
      assert.ok(p.length <= max, `piece of ${p.length} > ${max}`);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(p), "piece starts mid surrogate pair");
    }
  });
}
