// The replay matrix — every language the registry supports, crossed with the
// edit shapes and byte shapes a real session meets.
//
// The other oracles pin one mechanism each against a miniature. This one runs
// realistic files (`test/corpus/matrix/`) through the whole model-free pipeline
// the human actually drives:
//
//   extractSymbol -> buildReplaySteps -> resolveStep (the controller's loop)
//
// and asserts the only thing that matters at the end of it: the symbol the
// replay lands is the sandbox's symbol, byte for byte. Around that it pins the
// paths a step can take instead — the line-grain patch, the create walk, the
// whole-symbol insert, the file walk's segmentation, the delete strike.
//
// Two axes, both crossed with every language:
//
//   EDIT SHAPES — what the agent did to the symbol: a line changed, a line
//   added at the start / middle / end, a line deleted, an identifier renamed,
//   trivia added or removed, siblings reordered, a body rewritten whole.
//   `append at the end` and `insert above a blank line` are the two the field
//   census caught colliding; they are in every language's list on purpose.
//
//   BYTE SHAPES — how the file is spelled: LF, CRLF, no trailing newline,
//   unicode past the BMP, tabs for indentation. A grammar that is fine with
//   spaces and LF is not evidence about a file that uses neither.
//
// Every case is also a bounded-work check: a single symbol pair that takes
// longer than BUDGET_MS is a defect of its own — the extension host is single
// threaded and the human is holding Tab.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".replay-matrix.bundle.cjs");
const entry = path.join(__dirname, ".replay-matrix.entry.ts");
fs.writeFileSync(
  entry,
  `export { extractSymbol } from "../src/disclosure/resume";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n` +
    `export { classifyReplay } from "../src/disclosure/strategy";\n` +
    `export { resolveStep } from "../src/disclosure/replay";\n` +
    `export { parseRoot } from "../src/disclosure/diff";\n` +
    `export { computeSteps, walkableSource, countItemsByName } from "../src/disclosure/walk";\n` +
    `export { planFileWalk } from "../src/disclosure/fileWalk";\n` +
    `export { lineDiffSteps } from "../src/disclosure/lineDiff";\n` +
    `export { splitLeadingPad } from "../src/disclosure/insertion";\n` +
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
const {
  extractSymbol,
  buildReplaySteps,
  classifyReplay,
  resolveStep,
  parseRoot,
  computeSteps,
  walkableSource,
  countItemsByName,
  planFileWalk,
  lineDiffSteps,
  splitLeadingPad,
  RUST,
  CSHARP,
  TYPESCRIPT,
  TSX,
  PYTHON,
  MARKDOWN,
  HTML,
  CSS,
} = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const BUDGET_MS = 2000;
const corpus = (name) => fs.readFileSync(path.join(__dirname, "corpus", "matrix", name), "utf8");

// --- the surfaces under test ------------------------------------------------

// The controller's exact interactive loop: re-parse the live symbol, resolve
// the step against it, splice, book the self-edit on the ledger.
function replaySequential(before, after, spec) {
  const steps = buildReplaySteps(before, after, spec);
  let buf = before;
  let selfDelta = 0;
  const ledger = [];
  for (const [i, st] of steps.entries()) {
    const r = resolveStep(buf, parseRoot(buf, spec), st, selfDelta, ledger);
    assert.ok(r, `step ${i + 1}/${steps.length} collided — this is the collision modal the human meets`);
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
    ledger.push({ offset: r[0], rangeLength: r[1] - r[0], textLength: st.replacement.length, self: true });
  }
  return { text: buf, steps: steps.length };
}

// The walk contract: insert at the cursor, move the cursor.
function replayWalk(src, spec) {
  let buf = "";
  let cursor = 0;
  for (const s of computeSteps(src, spec)) {
    buf = buf.slice(0, cursor) + s.insert + buf.slice(cursor);
    cursor = s.cursorOffset;
  }
  return buf;
}

// The line-grain Patch surface: ops in old coordinates, applied in order.
function replayLinePatch(before, after) {
  let buf = before;
  let delta = 0;
  for (const st of lineDiffSteps(before, after)) {
    const start = st.start + delta;
    const end = st.end + delta;
    buf = buf.slice(0, start) + st.replacement + buf.slice(end);
    delta += st.replacement.length - (st.end - st.start);
  }
  return buf;
}

// --- edit builders ----------------------------------------------------------
// Each returns a function over the symbol's text, or null when the shape does
// not exist in that language (a `skip`, recorded, never a silent pass).

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const lines = (text) => text.split(/\r?\n/);
const joinLike = (parts, text) => parts.join(eolOf(text));
const indentOf = (line) => /^[ \t]*/.exec(line)[0];

// A multi-line needle is written once, in LF and spaces. Respell it the way the
// symbol under test is spelled, or the byte-shape variants silently stop
// exercising the multi-line edits — which is exactly the rewrite cutover, the
// most interesting case in the set.
const spellLike = (text, sym) => {
  let out = text;
  if (sym.includes("\r\n")) out = out.replace(/\n/g, "\r\n");
  if (/^\t/m.test(sym)) out = out.replace(/^(?: {2})+/gm, (run) => "\t".repeat(run.length / 2));
  return out;
};

const replaceOnce = (from, to) => (sym) => {
  const needle = spellLike(from, sym);
  const at = sym.indexOf(needle);
  if (at < 0 || sym.indexOf(needle, at + 1) >= 0) return null; // absent or ambiguous
  return sym.slice(0, at) + spellLike(to, sym) + sym.slice(at + needle.length);
};

const afterLineContaining = (marker, make) => (sym) => {
  const ls = lines(sym);
  const i = ls.findIndex((l) => l.includes(marker));
  if (i < 0) return null;
  ls.splice(i + 1, 0, make(indentOf(ls[i])));
  return joinLike(ls, sym);
};

const beforeLineContaining = (marker, make) => (sym) => {
  const ls = lines(sym);
  const i = ls.findIndex((l) => l.includes(marker));
  if (i < 0) return null;
  ls.splice(i, 0, make(indentOf(ls[i])));
  return joinLike(ls, sym);
};

const deleteLineContaining = (marker) => (sym) => {
  const ls = lines(sym);
  const i = ls.findIndex((l) => l.includes(marker));
  if (i < 0) return null;
  ls.splice(i, 1);
  return joinLike(ls, sym);
};

const swapLinesContaining = (a, b) => (sym) => {
  const ls = lines(sym);
  const i = ls.findIndex((l) => l.includes(a));
  const j = ls.findIndex((l) => l.includes(b));
  if (i < 0 || j < 0 || i === j) return null;
  const tmp = ls[i];
  ls[i] = ls[j];
  ls[j] = tmp;
  return joinLike(ls, sym);
};

// Append content at the end of the symbol's BODY — the shape the field census
// caught colliding: a paragraph on the tail of a markdown section, a statement
// on the tail of a function. In a brace language the symbol's last line is the
// closing delimiter and appending after it lands outside the symbol entirely
// (a vacuous edit, and a vacuous test), so the line goes in above it, at the
// indent of the line it follows.
const CLOSER = /^[\s})\];]*$|^\s*<\/[A-Za-z][^>]*>\s*$/;
const appendAtEnd = (make) => (sym) => {
  const eol = eolOf(sym);
  const tail = /\s*$/.exec(sym)[0];
  const body = sym.slice(0, sym.length - tail.length);
  const ls = lines(body);
  let at = ls.length; // append after the last content line
  while (at > 1 && CLOSER.test(ls[at - 1])) at--;
  if (at === 0) return null;
  const indent = indentOf(ls[at - 1] ?? "");
  ls.splice(at, 0, make(indent));
  return ls.join(eol) + tail;
};

// --- the corpus -------------------------------------------------------------
// symbol: what a guide step's **Symbol:** field would name.
// trivia: a line of attached trivia the language recognises, for the
//   add/remove-trivia cases.
// edits: the agent's change, per shape. A null return means "this shape does
//   not exist here" and the case is recorded as skipped, never passed.

const LANGUAGES = [
  {
    id: "rust",
    spec: () => RUST,
    file: "matrix-rust.rs",
    symbol: "total",
    trivia: "/// Sum the readings.",
    tabs: true,
    edits: {
      "one line changed": replaceOnce("sum += *reading;", "sum += *reading * 2;"),
      "line added at the start of the body": afterLineContaining("let mut sum = 0;", (ind) => `${ind}let mut seen = 0usize;`),
      "line added in the middle": beforeLineContaining("if sum > self.cap", (ind) => `${ind}// clamp last`),
      "line appended at the end": appendAtEnd((ind) => `${ind}// tail note`),
      "line deleted": deleteLineContaining("sum -= 1;"),
      "identifier renamed throughout": (sym) => sym.replace(/\bsum\b/g, "running"),
      "siblings reordered": swapLinesContaining("if *reading > 0 {", "sum += *reading;"),
      "signature only": replaceOnce("pub fn total(&self) -> i64", "pub fn total(&self) -> i128"),
      "body rewritten whole": replaceOnce(
        "        let mut sum = 0;\n        for reading in &self.readings {\n            if *reading > 0 {\n                sum += *reading;\n            } else {\n                sum -= 1;\n            }\n        }\n        if sum > self.cap {\n            sum = self.cap;\n        }\n        sum",
        "        self.readings.iter().map(|r| if *r > 0 { *r } else { -1 }).sum::<i64>().min(self.cap)",
      ),
    },
  },
  {
    id: "typescript",
    spec: () => TYPESCRIPT,
    file: "matrix-typescript.ts.txt",
    symbol: "total",
    trivia: "/** Sum the readings. */",
    tabs: true,
    edits: {
      "one line changed": replaceOnce("sum += reading;", "sum += reading * 2;"),
      "line added at the start of the body": afterLineContaining("let sum = 0;", (ind) => `${ind}let seen = 0;`),
      "line added in the middle": beforeLineContaining("if (sum > this.options.cap)", (ind) => `${ind}// clamp last`),
      "line appended at the end": appendAtEnd((ind) => `${ind}// tail note`),
      "line deleted": deleteLineContaining("sum -= 1;"),
      "identifier renamed throughout": (sym) => sym.replace(/\bsum\b/g, "running"),
      "siblings reordered": swapLinesContaining("if (reading > 0) {", "sum += reading;"),
      "signature only": replaceOnce("total(): number {", "total(): number | undefined {"),
      "body rewritten whole": replaceOnce(
        "    let sum = 0;\n    for (const reading of this.readings) {\n      if (reading > 0) {\n        sum += reading;\n      } else {\n        sum -= 1;\n      }\n    }\n    if (sum > this.options.cap) {\n      sum = this.options.cap;\n    }\n    return sum;",
        "    const raw = this.readings.reduce((acc, r) => acc + (r > 0 ? r : -1), 0);\n    return Math.min(raw, this.options.cap);",
      ),
    },
  },
  {
    id: "tsx",
    spec: () => TSX,
    file: "matrix-tsx.tsx.txt",
    symbol: "ReadingRow",
    trivia: "/** One row. */",
    tabs: true,
    edits: {
      "one line changed": replaceOnce('<td>{label}</td>', '<td title={label}>{label}</td>'),
      "line added at the start of the body": afterLineContaining("const tone =", (ind) => `${ind}const key = label.trim();`),
      "line added in the middle": beforeLineContaining("<td>{value}</td>", (ind) => `${ind}<td className="spacer" />`),
      "line appended at the end": appendAtEnd((ind) => `${ind}// tail note`),
      "line deleted": deleteLineContaining("<td>{value}</td>"),
      "identifier renamed throughout": (sym) => sym.replace(/\btone\b/g, "toneClass"),
      "siblings reordered": swapLinesContaining("<td>{label}</td>", "<td>{value}</td>"),
      "signature only": replaceOnce(
        "export function ReadingRow({ label, value, onPick }: ReadingRowProps): JSX.Element {",
        "export function ReadingRow({ label, value, onPick }: ReadingRowProps): React.ReactElement {",
      ),
      "body rewritten whole": replaceOnce(
        '  const tone = value < 0 ? "negative" : "positive";\n  return (\n    <tr className={tone} onClick={() => onPick(label)}>\n      <td>{label}</td>\n      <td>{value}</td>\n    </tr>\n  );',
        '  return (\n    <tr className={value < 0 ? "negative" : "positive"} onClick={() => onPick(label)}>\n      <td colSpan={2}>{`${label}: ${value}`}</td>\n    </tr>\n  );',
      ),
    },
  },
  {
    id: "csharp",
    spec: () => CSHARP,
    file: "matrix-csharp.cs",
    symbol: "Push",
    trivia: "/// <summary>Push one.</summary>",
    tabs: true,
    edits: {
      "one line changed": replaceOnce("_readings.Add(value);", "_readings.Add(value * 2);"),
      "line added at the start of the body": afterLineContaining("var index = _readings.Count;", (ind) => `${ind}var seen = 0;`),
      "line added in the middle": beforeLineContaining("if (!_labels.ContainsKey(label))", (ind) => `${ind}// first index wins`),
      "line appended at the end": appendAtEnd((ind) => `${ind}// tail note`),
      "line deleted": deleteLineContaining("_labels.Add(label, index);"),
      "identifier renamed throughout": (sym) => sym.replace(/\bindex\b/g, "slot"),
      "siblings reordered": swapLinesContaining("var index = _readings.Count;", "_readings.Add(value);"),
      "signature only": replaceOnce("public int Push(string label, int value)", "public int Push(string label, long value)"),
      "trivia block edited": replaceOnce("<remarks>A label already seen keeps its first index.</remarks>", "<remarks>First index wins.</remarks>"),
    },
  },
  {
    id: "python",
    spec: () => PYTHON,
    file: "matrix-python.py",
    symbol: "total",
    trivia: "# sum the readings",
    tabs: false, // indentation is semantic; a tab variant is a different program
    edits: {
      "one line changed": replaceOnce("total += reading", "total += reading * 2"),
      "line added at the start of the body": afterLineContaining("total = 0", (ind) => `${ind}seen = 0`),
      "line added in the middle": beforeLineContaining("if total > self._options.cap", (ind) => `${ind}# clamp last`),
      "line appended at the end": appendAtEnd((ind) => `${ind}# tail note`),
      "line deleted": deleteLineContaining("total -= 1"),
      "identifier renamed throughout": (sym) => sym.replace(/\breading\b/g, "sample"),
      "signature only": replaceOnce("def total(self) -> int:", "def total(self) -> int | None:"),
      "body rewritten whole": replaceOnce(
        "        total = 0\n        for reading in self._readings:\n            if reading > 0:\n                total += reading\n            else:\n                total -= 1\n        if total > self._options.cap:\n            total = self._options.cap\n        return total",
        "        raw = sum(r if r > 0 else -1 for r in self._readings)\n        return min(raw, self._options.cap)",
      ),
    },
  },
  {
    id: "markdown",
    spec: () => MARKDOWN,
    file: "matrix-markdown.md",
    symbol: "Configuration",
    trivia: undefined, // markdown sections carry no attached trivia
    tabs: false,
    edits: {
      "one line changed": replaceOnce("| `window` | 512 | Rolling window size, in samples |", "| `window` | 1024 | Rolling window size, in samples |"),
      "line added at the start of the body": afterLineContaining("## Configuration", () => ""),
      "row appended above a blank line": afterLineContaining("| `window` | 512 |", () => "| `feed` | none | Where to read samples from |"),
      "paragraph appended at the end": appendAtEnd(() => "\nOne more note about defaults."),
      "line deleted": deleteLineContaining("| `dropNegatives` | false |"),
      "identifier renamed throughout": (sym) => sym.replace(/`cap`/g, "`ceiling`"),
      "prose rewritten whole": replaceOnce(
        "A setting left unset takes the default. There is no config file; every setting\nis a flag or an environment variable.",
        "Every setting is a flag or an environment variable. There is no config file,\nand an unset setting takes the default shown above.",
      ),
    },
  },
  {
    id: "css",
    spec: () => CSS,
    file: "matrix-css.css",
    symbol: ".readings, .readings-compact",
    trivia: "/* the readings table */",
    tabs: true,
    edits: {
      "one line changed": replaceOnce("padding: var(--gap);", "padding: calc(var(--gap) * 1.5);"),
      "declaration added at the start": afterLineContaining("color: var(--ink);", (ind) => `${ind}outline: none;`),
      "declaration added in the middle": beforeLineContaining("border-collapse", (ind) => `${ind}margin: 0;`),
      "declaration appended at the end": appendAtEnd((ind) => `${ind}/* tail note */`),
      "declaration deleted": deleteLineContaining("border-collapse: collapse;"),
      "value renamed throughout": (sym) => sym.replace(/--gap/g, "--space"),
      "declarations reordered": swapLinesContaining("color: var(--ink);", "background: var(--paper);"),
      "custom property swapped": replaceOnce("background: var(--paper);", "background: var(--paper, #fff);"),
    },
  },
  {
    id: "html",
    spec: () => HTML,
    file: "matrix-html.html",
    symbol: "header#masthead",
    trivia: "<!-- the masthead -->",
    tabs: true,
    edits: {
      "one line changed": replaceOnce("<h1>Readings</h1>", "<h1>Live readings</h1>"),
      "child added at the start": afterLineContaining('<header id="masthead"', (ind) => `${ind}  <a href="#content">skip</a>`),
      "child added in the middle": beforeLineContaining('<span id="live-dot"', (ind) => `${ind}<!-- indicator -->`),
      "child appended at the end": appendAtEnd((ind) => `${ind}<!-- tail note -->`),
      "child deleted": deleteLineContaining('<span id="live-dot"'),
      "attribute renamed throughout": (sym) => sym.replace(/class="top"/g, 'class="masthead-top"'),
      "children reordered": swapLinesContaining("<h1>Readings</h1>", '<span id="live-dot"'),
    },
  },
];

// --- byte-shape variants ----------------------------------------------------
// Applied to the WHOLE corpus file before anything else, so extraction, the
// diff and the resolver all see the same spelling.

const VARIANTS = [
  { id: "lf", apply: (text) => text },
  { id: "crlf", apply: (text) => text.replace(/\n/g, "\r\n") },
  { id: "no trailing newline", apply: (text) => text.replace(/\n+$/, "") },
  {
    id: "unicode past the BMP",
    // Into comment and string territory only, so every corpus stays valid in
    // its own language.
    apply: (text) =>
      text
        .replace("readings", "readings 🎉 naïve")
        .replace("Readings", "Réadings 🎉")
        .replace("bounded", "bounded — ✅"),
  },
  {
    id: "tabs for indentation",
    onlyWhenTabsSafe: true,
    apply: (text) => text.replace(/^(?: {2})+/gm, (run) => "\t".repeat(run.length / 2)),
  },
  // A byte-order mark is what a Windows editor leaves at the head of the file.
  { id: "byte-order mark", apply: (text) => `\uFEFF${text}` },
  // Trailing whitespace an editor did not strip.
  { id: "trailing whitespace", apply: (text) => text.replace(/\n/g, "   \n") },
];

// Splice an edited symbol back into its file: a real file pair, not a symbol
// floating on its own.
function fileWithSymbol(fileText, symbolText, edited) {
  const at = fileText.indexOf(symbolText);
  assert.ok(at >= 0, "the extracted symbol must be a slice of the file");
  assert.strictEqual(fileText.indexOf(symbolText, at + 1), -1, "the corpus symbol must be unique in the file");
  return fileText.slice(0, at) + edited + fileText.slice(at + symbolText.length);
}

// --- the matrix -------------------------------------------------------------

const skipped = [];

for (const lang of LANGUAGES) {
  const spec = lang.spec();
  const baseFile = corpus(lang.file);

  for (const variant of VARIANTS) {
    if (variant.onlyWhenTabsSafe && !lang.tabs) {
      skipped.push(`${lang.id} x ${variant.id}: indentation is semantic in this language`);
      continue;
    }
    const file = variant.apply(baseFile);

    test(`${lang.id} [${variant.id}]: the symbol extracts as a byte-exact slice`, () => {
      const sym = extractSymbol(file, lang.symbol, spec);
      assert.ok(sym !== undefined, `\`${lang.symbol}\` must resolve`);
      assert.ok(file.includes(sym), "extraction invents nothing");
      assert.ok(/^\S/.test(sym), "extraction starts at the symbol's first visible byte");
      assert.strictEqual(splitLeadingPad(sym).pad, "", "an extracted symbol never leads with whitespace");
    });

    test(`${lang.id} [${variant.id}]: the file walk's segments rebuild the file`, () => {
      const segments = planFileWalk(file, spec);
      assert.ok(segments.length > 0, "a non-empty file must have segments");
      assert.strictEqual(segments.map((s) => s.sep + s.body).join(""), file, "segments concatenate to the file");
    });

    test(`${lang.id} [${variant.id}]: the create path rebuilds the symbol byte-exact`, () => {
      const sym = extractSymbol(file, lang.symbol, spec);
      if (walkableSource(sym, spec)) {
        assert.strictEqual(replayWalk(sym, spec), sym, "the descend-and-fill walk rebuilds the symbol");
      } else {
        const { text } = replaySequential("", sym, spec);
        assert.strictEqual(text, sym, "the whole-symbol insert rebuilds the symbol");
      }
    });

    test(`${lang.id} [${variant.id}]: a delete strikes the symbol to nothing`, () => {
      const sym = extractSymbol(file, lang.symbol, spec);
      const { text } = replaySequential(sym, "", spec);
      assert.strictEqual(text, "", "a delete step clears the symbol and invents nothing");
    });

    for (const [editName, edit] of Object.entries(lang.edits)) {
      test(`${lang.id} [${variant.id}] ${editName}: replays byte-exact`, () => {
        const before = extractSymbol(file, lang.symbol, spec);
        assert.ok(before !== undefined, "the target symbol must resolve");
        // The edit is written once, against the corpus as authored; the byte
        // shape is applied to BOTH sides afterwards. Editing the respelled file
        // instead would need every multi-line needle respelled too, and the
        // cells that quietly stopped matching would be the interesting ones.
        const baseSymbol = extractSymbol(baseFile, lang.symbol, spec);
        const editedBase = edit(baseSymbol);
        if (editedBase === null || editedBase === baseSymbol) {
          skipped.push(`${lang.id} x ${variant.id} x ${editName}: the shape does not occur in this corpus`);
          return;
        }
        const sandboxFile = variant.apply(fileWithSymbol(baseFile, baseSymbol, editedBase));
        const after = extractSymbol(sandboxFile, lang.symbol, spec);
        assert.ok(after !== undefined, "the sandbox symbol must resolve after the edit");
        assert.notStrictEqual(after, before, "the edit must reach the symbol in this byte shape");

        const started = Date.now();
        const { text } = replaySequential(before, after, spec);
        const elapsed = Date.now() - started;

        assert.strictEqual(text, after, "the replayed symbol equals the sandbox symbol byte for byte");
        assert.ok(elapsed < BUDGET_MS, `the pair took ${elapsed}ms — over the ${BUDGET_MS}ms budget`);
      });

      test(`${lang.id} [${variant.id}] ${editName}: the line-grain patch rebuilds it too`, () => {
        const before = extractSymbol(file, lang.symbol, spec);
        const baseSymbol = extractSymbol(baseFile, lang.symbol, spec);
        const editedBase = edit(baseSymbol);
        if (editedBase === null || editedBase === baseSymbol) return; // recorded above
        const after = extractSymbol(variant.apply(fileWithSymbol(baseFile, baseSymbol, editedBase)), lang.symbol, spec);
        assert.strictEqual(replayLinePatch(before, after), after, "the Patch surface is byte-exact too");
      });
    }
  }

  // A half-converted checkout leaves CRLF above some point in the file and LF
  // below it. It is not crossed with the edit shapes — the cut moves with the
  // file's length, so it cannot be applied identically to both sides of a pair
  // — but the engine must still read and rebuild such a file byte-exact.
  test(`${lang.id}: mixed line endings in one file still extract and replay byte-exact`, () => {
    const cut = baseFile.indexOf("\n", Math.floor(baseFile.length / 2));
    const mixed = baseFile.slice(0, cut).replace(/\n/g, "\r\n") + baseFile.slice(cut);
    const before = extractSymbol(mixed, lang.symbol, spec);
    assert.ok(before !== undefined && mixed.includes(before), "the symbol extracts as a slice of the mixed file");
    assert.strictEqual(
      planFileWalk(mixed, spec).map((s) => s.sep + s.body).join(""),
      mixed,
      "segmentation survives mixed terminators",
    );
    const edited = lang.edits["one line changed"](before);
    assert.ok(edited && edited !== before, "the one-line change must apply");
    const after = extractSymbol(fileWithSymbol(mixed, before, edited), lang.symbol, spec);
    assert.strictEqual(replaySequential(before, after, spec).text, after, "the replay is byte-exact either side of the cut");
  });

  // --- trivia symmetry, per language ---------------------------------------
  // The field defect: a target that carries a doc comment the sandbox dropped
  // (or the reverse) must still replay to the sandbox's exact bytes.
  if (lang.trivia !== undefined) {
    test(`${lang.id}: trivia added on one side only still replays byte-exact`, () => {
      const bare = extractSymbol(baseFile, lang.symbol, spec);
      const ls = lines(bare);
      const documented = joinLike([lang.trivia, ...ls], bare);
      const withFile = fileWithSymbol(baseFile, bare, documented);
      const documentedSymbol = extractSymbol(withFile, lang.symbol, spec);
      assert.ok(documentedSymbol !== undefined, "the documented symbol must resolve");
      assert.ok(documentedSymbol.startsWith(lang.trivia), "the trivia rides with the symbol");
      assert.strictEqual(
        /^[ \t]*/.exec(documentedSymbol)[0],
        /^[ \t]*/.exec(bare)[0],
        "adding trivia does not change the symbol's leading whitespace",
      );

      // Both directions: the sandbox adds the comment, and the sandbox drops it.
      assert.strictEqual(replaySequential(bare, documentedSymbol, spec).text, documentedSymbol, "trivia added");
      assert.strictEqual(replaySequential(documentedSymbol, bare, spec).text, bare, "trivia dropped");
    });
  }

  // --- the surgical / rewrite cutover is language-neutral -------------------
  test(`${lang.id}: a one-line change classifies surgical, a whole-body rewrite does not`, () => {
    const before = extractSymbol(baseFile, lang.symbol, spec);
    const small = lang.edits["one line changed"](before);
    assert.ok(small && small !== before, "the corpus must carry a one-line change");
    assert.strictEqual(classifyReplay(before, small, spec).strategy, "surgical", "a one-line change stays surgical");

    const whole = lang.edits["body rewritten whole"]?.(before) ?? lang.edits["prose rewritten whole"]?.(before);
    if (whole && whole !== before) {
      const plan = classifyReplay(before, whole, spec);
      assert.ok(plan.survival <= 1 && plan.survival >= 0, "survival is a fraction");
      assert.ok(plan.skeletonChange >= 0, "skeleton movement is a fraction");
    }
  });
}

// Renaming the symbol itself is not a modify step. The engine must say so by
// failing to resolve the old name, never by resolving to a neighbour that
// happens to be nearby — a guide that renames a symbol writes a delete and a
// create, and the runner surfaces "unresolved bytes" if it does not.
const RENAMES = [
  { id: "python", spec: () => PYTHON, file: "matrix-python.py", symbol: "total", rename: [/def total\(/, "def running("] },
  { id: "css", spec: () => CSS, file: "matrix-css.css", symbol: ".readings, .readings-compact", rename: [/\.readings-compact \{/, ".readings-dense {"] },
  { id: "rust", spec: () => RUST, file: "matrix-rust.rs", symbol: "total", rename: [/pub fn total\(/, "pub fn running("] },
];

for (const c of RENAMES) {
  test(`${c.id}: renaming the symbol makes it unresolvable, not a near miss`, () => {
    const spec = c.spec();
    const file = corpus(c.file);
    assert.ok(extractSymbol(file, c.symbol, spec) !== undefined, "the symbol resolves before the rename");
    const renamed = file.replace(c.rename[0], c.rename[1]);
    assert.notStrictEqual(renamed, file, "the rename must apply");
    assert.strictEqual(
      extractSymbol(renamed, c.symbol, spec),
      undefined,
      "the old name resolves to nothing — a rename is a delete plus a create, not a modify",
    );
  });
}

// A name that answers for more than one item is the engine's blind spot:
// `findItemByName` takes the first in document order, on BOTH sides, so the step
// either lands the sandbox's bytes on the wrong item or replays a no-op while
// the change the agent made never arrives — and neither is visible in the buffer
// afterwards. The count is what makes it visible; the guide runner warns on it
// and `scripts/validate-guide.js` flags it at authoring time. Measured over the
// replay guides on disk: 5 of 547 resolvable steps name an ambiguous symbol.
const AMBIGUOUS = [
  {
    id: "rust: the same method name in two impls",
    spec: () => RUST,
    symbol: "run",
    text: `impl A {\n    pub fn run(&self) -> i32 {\n        1\n    }\n}\n\nimpl B {\n    pub fn run(&self) -> i32 {\n        2\n    }\n}\n`,
    count: 2,
  },
  {
    id: "csharp: an overload pair",
    spec: () => CSHARP,
    symbol: "Run",
    text: `public class C\n{\n    public int Run() { return 1; }\n\n    public int Run(int x) { return x; }\n}\n`,
    count: 2,
  },
  {
    id: "markdown: a heading repeated per release",
    spec: () => MARKDOWN,
    symbol: "Fixed",
    text: `# Changelog\n\n## 2.0.0\n\n### Fixed\n\nthe new one\n\n## 1.0.0\n\n### Fixed\n\nthe old one\n`,
    count: 2,
  },
  {
    id: "typescript: a method name shared by two classes",
    spec: () => TYPESCRIPT,
    symbol: "run",
    text: `class A {\n  run(): number {\n    return 1;\n  }\n}\n\nclass B {\n  run(): number {\n    return 2;\n  }\n}\n`,
    count: 2,
  },
];

for (const c of AMBIGUOUS) {
  test(`ambiguity is countable — ${c.id}`, () => {
    const spec = c.spec();
    assert.strictEqual(countItemsByName(parseRoot(c.text, spec), c.text, c.symbol, spec), c.count, "every candidate is counted");
    // And the documented consequence: extraction takes the first, so a replay
    // built from this name is a coin flip the human has to be told about.
    const got = extractSymbol(c.text, c.symbol, spec);
    assert.ok(got !== undefined, "the name still resolves — to the first candidate");
    assert.strictEqual(c.text.indexOf(got), c.text.indexOf(got), "and it is a real slice");
  });
}

test("ambiguity is countable — an unambiguous name counts once, an absent one counts zero", () => {
  const text = corpus("matrix-rust.rs");
  assert.strictEqual(countItemsByName(parseRoot(text, RUST), text, "collect_all", RUST), 1);
  assert.strictEqual(countItemsByName(parseRoot(text, RUST), text, "no_such_symbol", RUST), 0);
});

// The skip list is evidence, not decoration: a shape that silently stops being
// exercised is how a matrix rots. Anything here is a gap the human can read.
test("matrix coverage: every skipped cell names why it was skipped", () => {
  for (const line of skipped) assert.match(line, /: .+/, "a skip must carry its reason");
  // The list itself is the report: node --test prints it on demand.
  if (process.env.MATRIX_SKIPS) console.log(skipped.sort().join("\n"));
});
