// Field defects — the shapes that sent the human back to copy-paste.
//
// Every case here is RECORDED, not invented: real before/after bytes harvested
// from a repo's git history (`scripts/harvest-replay.js`) and trimmed to the
// enclosing item, with the symbol's own bytes preserved byte-for-byte. Each
// test names the invariant the incident broke:
//
//   - trivia asymmetry: the same symbol must extract the same way whether or
//     not it carries a doc comment, so a replay against a target whose comment
//     the sandbox dropped lands the sandbox bytes and nothing else;
//   - insert at the start of a symbol: adding a doc comment above a method is
//     an ordinary step, not a collision;
//   - append at the end of a symbol: the most common shape in the census (a
//     paragraph on a section, a statement on a function) must land;
//   - insert before blank lines: a right context of blank lines is context,
//     not an absence of context.
//
// Provenance is in each corpus fixture's test below (repo, commit, path). The
// TypeScript fixtures carry a `.ts.txt` suffix so `node --test` reads them as
// corpus and not as test files.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".field-defects.bundle.cjs");
const entry = path.join(__dirname, ".field-defects.entry.ts");
fs.writeFileSync(
  entry,
  `export { extractSymbol } from "../src/disclosure/resume";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n` +
    `export { resolveStep, resolveStepNoTree } from "../src/disclosure/replay";\n` +
    `export { lineDiffSteps } from "../src/disclosure/lineDiff";\n` +
    `export { parseRoot } from "../src/disclosure/diff";\n` +
    `export { TYPESCRIPT, MARKDOWN } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { extractSymbol, buildReplaySteps, resolveStep, resolveStepNoTree, lineDiffSteps, parseRoot, TYPESCRIPT, MARKDOWN } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const corpus = (name) => fs.readFileSync(path.join(__dirname, "corpus", name), "utf8");

// The controller's exact interactive loop: re-parse, resolve, apply, book the
// self-edit. Returns the rebuilt symbol, or throws naming the step that
// collided — a collision IS the failure being pinned, so it must not pass
// silently as "no ops to apply".
function replaySequential(before, after, spec) {
  const steps = buildReplaySteps(before, after, spec);
  assert.ok(steps.length > 0, "a changed symbol must produce at least one op");
  let buf = before;
  let selfDelta = 0;
  const ledger = [];
  for (const [i, st] of steps.entries()) {
    const r = resolveStep(buf, parseRoot(buf, spec), st, selfDelta, ledger);
    assert.ok(r, `step ${i + 1}/${steps.length} collided — the human meets the collision modal here`);
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
    ledger.push({ offset: r[0], rangeLength: r[1] - r[0], textLength: st.replacement.length, self: true });
  }
  return buf;
}

// file: the two corpus fixtures. symbol: what a guide step would name.
const CASES = [
  {
    name: "trivia asymmetry: the target's doc comment is not the sandbox's indent",
    // column-80 @459f93cc, src/core/dictationDoc.ts — the target carries two
    // comment lines above `const allman`, the sandbox carries none.
    before: "field-ts-trivia-asymmetry-before.ts.txt",
    after: "field-ts-trivia-asymmetry-after.ts.txt",
    symbol: "allman",
    spec: () => TYPESCRIPT,
  },
  {
    name: "insert at the start: a doc comment lands above an existing method",
    // column-80 @286779ac, src/core/capture.ts — `abort` gains a doc comment
    // and an early return.
    before: "field-ts-insert-start-before.ts.txt",
    after: "field-ts-insert-start-after.ts.txt",
    symbol: "abort",
    spec: () => TYPESCRIPT,
  },
  {
    name: "append at the end: paragraphs land on the tail of a section",
    // column-80 @0bbe7340, docs/architecture/dictation.md — a pure insert of
    // 1461 bytes at the section's last byte.
    before: "field-md-append-section-before.md",
    after: "field-md-append-section-after.md",
    symbol: "The recogniser and the recorder",
    spec: () => MARKDOWN,
  },
  {
    name: "insert before blank lines: a table gains a row mid-section",
    // column-80 @bfd2d3e9, ARCHITECTURE.md — the insert point is followed by
    // a blank line, so the baked right context is whitespace only.
    before: "field-md-table-row-before.md",
    after: "field-md-table-row-after.md",
    symbol: "Subsystem map",
    spec: () => MARKDOWN,
  },
];

for (const c of CASES) {
  test(`field defect — ${c.name}`, () => {
    const spec = c.spec();
    const targetFile = corpus(c.before);
    const sandboxFile = corpus(c.after);
    const before = extractSymbol(targetFile, c.symbol, spec);
    const after = extractSymbol(sandboxFile, c.symbol, spec);
    assert.ok(before !== undefined, "the target symbol must resolve");
    assert.ok(after !== undefined, "the sandbox symbol must resolve");
    assert.notStrictEqual(before, after, "the fixture must be a real modify");
    assert.strictEqual(
      replaySequential(before, after, spec),
      after,
      "the replayed symbol must equal the sandbox symbol byte for byte",
    );
  });
}

// The invariant under the first case, stated directly: extraction must not
// depend on whether an item carries trivia. Two files, same item, same
// container depth — one with a doc comment, one without. Whatever the engine
// decides the symbol's leading bytes are, it must decide it the same way for
// both, or every comparison downstream (the diff, the proof's left context,
// resume's landed check) reads a phantom indent change.
test("extraction is indentation-symmetric: trivia does not change the symbol's leading bytes", () => {
  const withTrivia = `class C {\n  // why this exists\n  run(): number {\n    return 1;\n  }\n}\n`;
  const without = `class C {\n  run(): number {\n    return 1;\n  }\n}\n`;
  const a = extractSymbol(withTrivia, "run", TYPESCRIPT);
  const b = extractSymbol(without, "run", TYPESCRIPT);
  assert.ok(a !== undefined && b !== undefined, "both must resolve");
  const leading = (s) => /^[ \t]*/.exec(s)[0];
  assert.strictEqual(
    leading(a),
    leading(b),
    `trivia changed the symbol's leading whitespace: ${JSON.stringify(leading(a))} vs ${JSON.stringify(leading(b))}`,
  );
  assert.ok(withTrivia.includes(a) && without.includes(b), "extraction stays a byte-exact slice");
});

// The line-grain Patch surface resolves with NO structural leg — a patch's hunks
// live between lines, not tree nodes, and the file may have no grammar at all.
// The insert proof is the only thing standing between it and a stale landing, so
// the same four shapes are pinned here too, one layer down.
const PATCH_SHAPES = [
  { name: "append at the end of a file", before: "alpha\nbeta\n", after: "alpha\nbeta\ngamma\n" },
  { name: "append at the end of a file with no trailing newline", before: "alpha\nbeta", after: "alpha\nbeta\ngamma" },
  { name: "insert above a blank line", before: "alpha\n\nomega\n", after: "alpha\nbeta\n\nomega\n" },
  { name: "insert among identical blocks", before: "x\n\nx\n\nx\n", after: "x\n\nx\nnew\n\nx\n" },
];

for (const shape of PATCH_SHAPES) {
  test(`patch surface (no structural leg) — ${shape.name}`, () => {
    const steps = lineDiffSteps(shape.before, shape.after);
    assert.ok(steps.length > 0, "a changed file must produce at least one hunk");
    let buf = shape.before;
    let selfDelta = 0;
    const ledger = [];
    for (const [i, st] of steps.entries()) {
      const r = resolveStepNoTree(buf, st, selfDelta, ledger);
      assert.ok(r, `hunk ${i + 1}/${steps.length} collided`);
      assert.strictEqual(buf.slice(r[0], r[1]), st.originalText, "a hunk only replaces bytes it was built against");
      buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
      selfDelta += st.replacement.length - (r[1] - r[0]);
      ledger.push({ offset: r[0], rangeLength: r[1] - r[0], textLength: st.replacement.length, self: true });
    }
    assert.strictEqual(buf, shape.after, "the patched file equals the sandbox file byte for byte");
  });
}
