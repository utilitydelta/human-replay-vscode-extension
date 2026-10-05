// Human-edit limits — where a line the human adds mid-replay is absorbed, and
// where it surfaces, measured at every line of every language.
//
// Each case is a modify the diff-replay engine runs (recorded field pairs plus
// the per-language matrix symbols, given a second hunk so there are steps on
// both sides of most positions). The human's line goes in BEFORE the replay,
// at each line start of the target symbol in turn, booked on the ledger as a
// foreign edit, exactly as the controller books a change it did not make.
//
// The contract is the divergence matrix's, swept over every position:
//
//   - land the sandbox's bytes AND keep the human's line, or collide;
//   - never write over bytes a step was not built against;
//   - never a third thing: a clean replay whose result, minus the human's
//     line, is not the sandbox symbol.
//
// The absorbed/surfaced split per case is reported as a diagnostic, not
// asserted: it is the measured practical limit (session-v4/limits.md), and a
// change that moves it should be seen, not silently re-pinned.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".human-edit-limits.bundle.cjs");
const entry = path.join(__dirname, ".human-edit-limits.entry.ts");
fs.writeFileSync(
  entry,
  `export { extractSymbol } from "../src/disclosure/resume";\n` +
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
const { extractSymbol, buildReplaySteps, resolveStep, parseRoot, RUST, CSHARP, TYPESCRIPT, TSX, PYTHON, MARKDOWN, HTML, CSS } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const read = (rel) => fs.readFileSync(path.join(__dirname, "corpus", rel), "utf8");

// Same loop as the divergence matrix: one foreign edit booked, then every step
// resolved and applied in order, each self accept booked behind it.
function replayDiverged(before, after, spec, foreign) {
  const steps = buildReplaySteps(before, after, spec);
  let buf = foreign.text;
  let selfDelta = 0;
  const ledger = [{ offset: foreign.offset, rangeLength: 0, textLength: foreign.textLength, self: false }];
  const overwrote = [];
  for (const [i, st] of steps.entries()) {
    const r = resolveStep(buf, parseRoot(buf, spec), st, selfDelta, ledger);
    if (!r) return { collided: true, at: i, of: steps.length, overwrote };
    if (buf.slice(r[0], r[1]) !== st.originalText) overwrote.push(i);
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
    ledger.push({ offset: r[0], rangeLength: r[1] - r[0], textLength: st.replacement.length, self: true });
  }
  return { collided: false, text: buf, overwrote, of: steps.length };
}

// A second hunk for the one-line matrix pairs: a sandbox line added before
// the symbol's last line, in the language's own comment syntax.
function addBeforeLast(sym, line) {
  const body = sym.replace(/\n$/, "");
  const cut = body.lastIndexOf("\n") + 1;
  const indent = /^[ \t]*/.exec(body.slice(cut))[0];
  return body.slice(0, cut) + indent + "    " + line + "\n" + body.slice(cut) + sym.slice(body.length);
}

const COMMENT = {
  rust: (i) => `${i}// human note`,
  ts: (i) => `${i}// human note`,
  csharp: (i) => `${i}// human note`,
  python: (i) => `${i}# human note`,
  css: (i) => `${i}/* human note */`,
  html: (i) => `${i}<!-- human note -->`,
  markdown: () => "A human note.",
};

const MATRIX = [
  { id: "rust", spec: RUST, file: "matrix/matrix-rust.rs", symbol: "total", c: COMMENT.rust, edit: (s) => s.replace("sum += *reading;", "sum += *reading * 2;"), extra: "// sandbox note" },
  { id: "typescript", spec: TYPESCRIPT, file: "matrix/matrix-typescript.ts.txt", symbol: "total", c: COMMENT.ts, edit: (s) => s.replace("sum += reading;", "sum += reading * 2;"), extra: "// sandbox note" },
  { id: "tsx", spec: TSX, file: "matrix/matrix-tsx.tsx.txt", symbol: "ReadingRow", c: COMMENT.ts, edit: (s) => s.replace("<td>{value}</td>", "<td>{value.toFixed(2)}</td>"), extra: "// sandbox note" },
  { id: "csharp", spec: CSHARP, file: "matrix/matrix-csharp.cs", symbol: "Push", c: COMMENT.csharp, edit: (s) => s.replace("_readings.Add(value);", "_readings.Add(value * 2);"), extra: "// sandbox note" },
  { id: "python", spec: PYTHON, file: "matrix/matrix-python.py", symbol: "total", c: COMMENT.python, edit: (s) => s.replace("total += reading", "total += reading * 2"), extra: "# sandbox note" },
  { id: "markdown", spec: MARKDOWN, file: "matrix/matrix-markdown.md", symbol: "Configuration", c: COMMENT.markdown, edit: (s) => s.replace("| `window` | 512 |", "| `window` | 1024 |"), extra: null },
  { id: "css", spec: CSS, file: "matrix/matrix-css.css", symbol: ".readings, .readings-compact", c: COMMENT.css, edit: (s) => s.replace("padding: var(--gap);", "padding: var(--gap) 0;"), extra: "/* sandbox note */" },
  { id: "html", spec: HTML, file: "matrix/matrix-html.html", symbol: "header#masthead", c: COMMENT.html, edit: (s) => s.replace("<h1>Readings</h1>", "<h1>Live readings</h1>"), extra: "<!-- sandbox note -->" },
];

const CASES = [
  ...MATRIX.map((m) => {
    const before = extractSymbol(read(m.file), m.symbol, m.spec);
    const edited = m.edit(before);
    return { name: `${m.id} matrix`, spec: m.spec, before, after: m.extra ? addBeforeLast(edited, m.extra) : edited, comment: m.c };
  }),
  // Recorded pairs: whole-symbol bytes from the field (see field-defects and
  // insert-proof for provenance).
  { name: "rust sync (recorded)", spec: RUST, before: read("corpus-old-sync.rs"), after: read("corpus-new-sync.rs"), comment: COMMENT.rust },
  {
    name: "typescript abort (recorded)",
    spec: TYPESCRIPT,
    before: extractSymbol(read("field-ts-insert-start-before.ts.txt"), "abort", TYPESCRIPT),
    after: extractSymbol(read("field-ts-insert-start-after.ts.txt"), "abort", TYPESCRIPT),
    comment: COMMENT.ts,
  },
  {
    name: "markdown section append (recorded)",
    spec: MARKDOWN,
    before: extractSymbol(read("field-md-append-section-before.md"), "The recogniser and the recorder", MARKDOWN),
    after: extractSymbol(read("field-md-append-section-after.md"), "The recogniser and the recorder", MARKDOWN),
    comment: COMMENT.markdown,
  },
];

for (const c of CASES) {
  test(`${c.name}: a human line at every line start — kept with the sandbox's bytes, or surfaced`, (t) => {
    assert.ok(c.before !== undefined && c.after !== undefined && c.before !== c.after, "a real modify pair");
    const starts = [0];
    for (let i = 0; i < c.before.length - 1; i++) if (c.before[i] === "\n") starts.push(i + 1);
    let absorbed = 0;
    const surfaced = [];
    for (const [ln, at] of starts.entries()) {
      const indent = /^[ \t]*/.exec(c.before.slice(at))[0];
      const line = c.comment(indent) + "\n";
      const foreign = { text: c.before.slice(0, at) + line + c.before.slice(at), offset: at, textLength: line.length };
      const r = replayDiverged(c.before, c.after, c.spec, foreign);
      assert.deepStrictEqual(r.overwrote, [], `line ${ln + 1}: a step wrote over bytes it was not built against`);
      if (r.collided) {
        surfaced.push(ln + 1);
        continue;
      }
      const idx = r.text.indexOf(line);
      assert.ok(idx >= 0 && r.text.indexOf(line, idx + 1) < 0, `line ${ln + 1}: the human's line survives exactly once`);
      assert.strictEqual(r.text.slice(0, idx) + r.text.slice(idx + line.length), c.after, `line ${ln + 1}: minus the human's line, the result is the sandbox symbol`);
      absorbed++;
    }
    t.diagnostic(`${c.name}: ${absorbed}/${starts.length} line positions absorbed; surfaced at ${surfaced.length ? surfaced.join(",") : "none"}`);
  });
}
