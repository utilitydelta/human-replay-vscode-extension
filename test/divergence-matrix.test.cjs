// Divergence — the human types while the replay is mid-symbol.
//
// A replay is not a batch. Between two Tabs the human can fix a typo, add a
// note, or rewrite the very line the next step was going to touch. The engine's
// contract there is narrow and absolute:
//
//   land the sandbox's bytes AND keep the human's, or collide and surface.
//   Never a third thing.
//
// So each case here diverges the buffer and then demands one of exactly two
// outcomes. A step that resolves must produce the merge that keeps both sides;
// a step that cannot must return null (the collision modal), which is a
// success here, not a failure. What must never happen is a resolve that lands
// bytes neither side asked for — that is the shape the human only notices in a
// diff review, long after the session.
//
// The second half is resume: the verdict "was this step already landed" is
// derived from real bytes on both sides, so it survives a reload, a rollback,
// and an out-of-band edit. A wrong verdict either replays a landed step twice
// or skips one that never ran.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".divergence.bundle.cjs");
const entry = path.join(__dirname, ".divergence.entry.ts");
fs.writeFileSync(
  entry,
  `export { extractSymbol, stepAlreadyLanded } from "../src/disclosure/resume";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n` +
    `export { resolveStep } from "../src/disclosure/replay";\n` +
    `export { parseRoot } from "../src/disclosure/diff";\n` +
    `export { RUST, CSHARP, TYPESCRIPT, TSX, PYTHON, MARKDOWN, HTML, CSS } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { extractSymbol, stepAlreadyLanded, buildReplaySteps, resolveStep, parseRoot, RUST, CSHARP, TYPESCRIPT, TSX, PYTHON, MARKDOWN, HTML, CSS } =
  require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const corpus = (name) => fs.readFileSync(path.join(__dirname, "corpus", "matrix", name), "utf8");

// Replay against a buffer the human has already changed. The foreign edit is
// booked on the ledger the way the controller books a document change it did
// not make (`self: false`), which is what lets the observed-delta ledger
// transform an unlanded insert point across it.
function replayDiverged(before, after, spec, foreign) {
  const steps = buildReplaySteps(before, after, spec);
  let buf = foreign.text;
  let selfDelta = 0;
  const ledger = [{ offset: foreign.offset, rangeLength: foreign.rangeLength, textLength: foreign.textLength, self: false }];
  const overwrote = [];
  for (const [i, st] of steps.entries()) {
    const r = resolveStep(buf, parseRoot(buf, spec), st, selfDelta, ledger);
    if (!r) return { collided: true, at: i, of: steps.length, text: buf, overwrote };
    // The no-clobber invariant, checked on every leg: a step only ever replaces
    // bytes it RECOGNISES. A pure insert is zero-width and replaces nothing; any
    // other step's live range must hold exactly the bytes it was built against.
    // Anything else is the engine writing over something it never read.
    const live = buf.slice(r[0], r[1]);
    if (live !== st.originalText) overwrote.push({ step: i, live, expected: st.originalText });
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
    ledger.push({ offset: r[0], rangeLength: r[1] - r[0], textLength: st.replacement.length, self: true });
  }
  return { collided: false, text: buf, overwrote };
}

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const lines = (text) => text.split(/\r?\n/);
const indentOf = (line) => /^[ \t]*/.exec(line)[0];

// Insert `line` immediately after the symbol's first line — territory no case
// below touches, so the merge that keeps both sides is exactly "the sandbox
// symbol with this line in the same place".
function insertAfterFirstLine(sym, makeLine) {
  const eol = eolOf(sym);
  const ls = lines(sym);
  const text = makeLine(indentOf(ls[1] ?? ls[0]));
  const at = sym.indexOf(eol) + eol.length;
  return { text: sym.slice(0, at) + text + eol + sym.slice(at), offset: at, rangeLength: 0, textLength: text.length + eol.length };
}

// language: corpus + the symbol a guide step would name + the shapes the
// divergence cases need spelled in that language.
const LANGUAGES = [
  {
    id: "rust",
    spec: () => RUST,
    file: "matrix-rust.rs",
    symbol: "total",
    foreign: (ind) => `${ind}// human note`,
    edit: (sym) => sym.replace("sum += *reading;", "sum += *reading * 2;"),
    clobberLine: "sum += *reading;",
    clobberWith: "sum = sum.saturating_add(*reading);",
  },
  {
    id: "typescript",
    spec: () => TYPESCRIPT,
    file: "matrix-typescript.ts.txt",
    symbol: "total",
    foreign: (ind) => `${ind}// human note`,
    edit: (sym) => sym.replace("sum += reading;", "sum += reading * 2;"),
    clobberLine: "sum += reading;",
    clobberWith: "sum = sum + reading;",
  },
  {
    id: "tsx",
    spec: () => TSX,
    file: "matrix-tsx.tsx.txt",
    symbol: "ReadingRow",
    foreign: (ind) => `${ind}// human note`,
    edit: (sym) => sym.replace("<td>{value}</td>", "<td>{value.toFixed(2)}</td>"),
    clobberLine: "<td>{value}</td>",
    clobberWith: "<td>{String(value)}</td>",
  },
  {
    id: "csharp",
    spec: () => CSHARP,
    file: "matrix-csharp.cs",
    symbol: "Push",
    foreign: (ind) => `${ind}// human note`,
    edit: (sym) => sym.replace("_readings.Add(value);", "_readings.Add(value * 2);"),
    clobberLine: "_readings.Add(value);",
    clobberWith: "_readings.Add(checked(value));",
  },
  {
    id: "python",
    spec: () => PYTHON,
    file: "matrix-python.py",
    symbol: "total",
    foreign: (ind) => `${ind}# human note`,
    edit: (sym) => sym.replace("total += reading", "total += reading * 2"),
    clobberLine: "total += reading\n",
    clobberWith: "total += int(reading)\n",
  },
  {
    id: "markdown",
    spec: () => MARKDOWN,
    file: "matrix-markdown.md",
    symbol: "Configuration",
    foreign: () => "A human note.",
    edit: (sym) => sym.replace("| `window` | 512 |", "| `window` | 1024 |"),
    clobberLine: "| `window` | 512 | Rolling window size, in samples |",
    clobberWith: "| `window` | 256 | Rolling window size, in samples |",
  },
  {
    id: "css",
    spec: () => CSS,
    file: "matrix-css.css",
    symbol: ".readings, .readings-compact",
    foreign: (ind) => `${ind}/* human note */`,
    edit: (sym) => sym.replace("padding: var(--gap);", "padding: var(--gap) 0;"),
    clobberLine: "padding: var(--gap);",
    clobberWith: "padding: 4px;",
  },
  {
    id: "html",
    spec: () => HTML,
    file: "matrix-html.html",
    symbol: "header#masthead",
    foreign: (ind) => `${ind}<!-- human note -->`,
    edit: (sym) => sym.replace("<h1>Readings</h1>", "<h1>Live readings</h1>"),
    clobberLine: "<h1>Readings</h1>",
    clobberWith: "<h1>Readings feed</h1>",
  },
];

for (const lang of LANGUAGES) {
  const spec = lang.spec();
  const file = corpus(lang.file);
  const before = extractSymbol(file, lang.symbol, spec);
  const after = extractSymbol(file.replace(before, lang.edit(before)), lang.symbol, spec);

  test(`${lang.id}: the corpus pair is a real modify`, () => {
    assert.ok(before !== undefined && after !== undefined, "both sides resolve");
    assert.notStrictEqual(before, after, "the edit applies");
  });

  test(`${lang.id}: a human line typed above the step's target — both sides survive, or it collides`, () => {
    const foreign = insertAfterFirstLine(before, lang.foreign);
    const result = replayDiverged(before, after, spec, foreign);
    assert.deepStrictEqual(result.overwrote, [], "a step wrote over bytes that were not the ones it was built against");
    if (result.collided) return; // an honest surface is a permitted outcome
    const wanted = insertAfterFirstLine(after, lang.foreign).text;
    assert.strictEqual(result.text, wanted, "the merge keeps the sandbox's bytes AND the human's line");
  });

  test(`${lang.id}: the human rewrites the very line the step targets — nothing is written over unread bytes`, () => {
    const at = before.indexOf(lang.clobberLine);
    assert.ok(at >= 0, `the corpus must contain ${JSON.stringify(lang.clobberLine)}`);
    const diverged = before.slice(0, at) + lang.clobberWith + before.slice(at + lang.clobberLine.length);
    const foreign = {
      text: diverged,
      offset: at,
      rangeLength: lang.clobberLine.length,
      textLength: lang.clobberWith.length,
    };
    const result = replayDiverged(before, after, spec, foreign);
    // Either outcome is honest — a collision surfaces to the human, and a
    // resolve is allowed to land at sub-line grain when the bytes it targets
    // are still there (the engine can replace a word inside a line the human
    // extended). What is never allowed is replacing bytes it did not read.
    assert.deepStrictEqual(result.overwrote, [], "a step wrote over bytes that were not the ones it was built against");
  });

  test(`${lang.id}: replaying into an already-landed symbol is a no-op, not a double landing`, () => {
    // The buffer is already the sandbox's. Every step either resolves to a
    // range that already holds its replacement, or collides. Neither may
    // duplicate the change.
    const result = replayDiverged(after, after, spec, { text: after, offset: 0, rangeLength: 0, textLength: 0 });
    assert.ok(!result.collided, "an unchanged pair produces no steps to collide on");
    assert.strictEqual(result.text, after, "nothing lands twice");
  });

  // --- resume: the verdict comes from bytes, never from a saved counter -----

  test(`${lang.id}: resume — landed, not landed, and gone are all decided by real bytes`, () => {
    assert.strictEqual(stepAlreadyLanded("modify", after, after), true, "target equals sandbox: landed");
    assert.strictEqual(stepAlreadyLanded("modify", before, after), false, "target still the old bytes: not landed");
    assert.strictEqual(stepAlreadyLanded("modify", undefined, after), false, "no target symbol: no verdict, not landed");
    assert.strictEqual(stepAlreadyLanded("modify", after, undefined), false, "no sandbox symbol: no evidence, not landed");
    assert.strictEqual(stepAlreadyLanded("create", after, after), true, "a create is landed when the symbol matches");
    assert.strictEqual(stepAlreadyLanded("delete", undefined, undefined), true, "a delete is landed when the symbol is gone");
    assert.strictEqual(stepAlreadyLanded("delete", before, undefined), false, "a delete with the symbol still there is not landed");
  });

  test(`${lang.id}: resume — a partly landed symbol is not "landed"`, () => {
    const steps = buildReplaySteps(before, after, spec);
    if (steps.length < 2) return; // a single-op pair has no partial state
    let buf = before;
    let selfDelta = 0;
    const ledger = [];
    const st = steps[0];
    const r = resolveStep(buf, parseRoot(buf, spec), st, selfDelta, ledger);
    assert.ok(r, "the first step must resolve on a clean buffer");
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    assert.strictEqual(stepAlreadyLanded("modify", buf, after), false, "half the ops in is not landed");
  });

  test(`${lang.id}: resume — an out-of-band edit to a landed symbol reads as not landed`, () => {
    const touched = `${after}${after.endsWith("\n") ? "" : "\n"}`.replace(lang.clobberLine, lang.clobberWith);
    if (touched === after) return; // the clobber line lives in the changed region
    assert.strictEqual(stepAlreadyLanded("modify", touched, after), false, "a byte off the sandbox is not landed");
  });
}
