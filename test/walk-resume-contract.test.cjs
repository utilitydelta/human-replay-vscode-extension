// Contract oracles for create-file resume with human additions
// (resumeWalk and landedWithAdditions in src/disclosure/fileWalk.ts).
//
// A create-file walk lands a file segment by segment. The human may type whole
// lines of their own between Tabs (a comment above landed code). Resume must
// tolerate those added lines and nothing else: a changed sandbox line, a partly
// landed next segment, or a foreign file never resumes in a way that would land
// bytes twice or claim bytes that are not there. Parameterized over every
// language's matrix corpus file.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const EXTERNALS = ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"];

const entry = path.join(__dirname, ".walk-resume-contract.entry.ts");
const bundle = path.join(__dirname, ".walk-resume-contract.bundle.cjs");
fs.writeFileSync(
  entry,
  `export { planFileWalk, resumeWalk, landedWithAdditions } from "../src/disclosure/fileWalk";\n` +
    `export { RUST, CSHARP, TYPESCRIPT, TSX, PYTHON, MARKDOWN, HTML, CSS } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: EXTERNALS,
});
const { planFileWalk, resumeWalk, landedWithAdditions, RUST, CSHARP, TYPESCRIPT, TSX, PYTHON, MARKDOWN, HTML, CSS } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const MATRIX = path.join(__dirname, "corpus", "matrix");
const LANGS = [
  { name: "rust", file: "matrix-rust.rs", spec: () => RUST, note: "// human note" },
  { name: "csharp", file: "matrix-csharp.cs", spec: () => CSHARP, note: "// human note" },
  { name: "typescript", file: "matrix-typescript.ts.txt", spec: () => TYPESCRIPT, note: "// human note" },
  { name: "tsx", file: "matrix-tsx.tsx.txt", spec: () => TSX, note: "// human note" },
  { name: "python", file: "matrix-python.py", spec: () => PYTHON, note: "# human note" },
  { name: "markdown", file: "matrix-markdown.md", spec: () => MARKDOWN, note: "A human note." },
  { name: "html", file: "matrix-html.html", spec: () => HTML, note: "<!-- human note -->" },
  { name: "css", file: "matrix-css.css", spec: () => CSS, note: "/* human note */" },
];

const prefix = (segs, k) => segs.slice(0, k).map((s) => s.sep + s.body).join("");

// Insert `line` as a whole line before line index i of `text`.
function insertLine(text, i, line) {
  const lines = text.split("\n");
  lines.splice(i, 0, line);
  return lines.join("\n");
}

// Append `line` as a whole line after `text`, optionally newline-terminated.
function appendLine(text, line, trailingNewline) {
  const base = text === "" || text.endsWith("\n") ? text : text + "\n";
  return base + line + (trailingNewline ? "\n" : "");
}

// The contract's leadTyped (amended): match P_k's lines into existing's lines as
// an in-order whole-line subsequence (earliest match), find the target line j
// that P_k's final split element matched, and take tail = existing from the end
// of line j. leadTyped is the longest prefix of sep that is a suffix of tail, so
// a newline ending P_k's own last line never counts as typed separator.
function expectedLeadTyped(sep, landed, existing) {
  const want = landed.split("\n");
  const have = existing.split("\n");
  let j = -1;
  for (const line of want) {
    j = have.indexOf(line, j + 1);
    if (j < 0) throw new Error("helper: landed bytes are not a line-subsequence of existing");
  }
  let lineEnd = 0;
  for (let i = 0; i < j; i++) lineEnd += have[i].length + 1;
  lineEnd += have[j].length;
  const tail = existing.slice(lineEnd);
  for (let n = sep.length; n > 0; n--) if (tail.endsWith(sep.slice(0, n))) return n;
  return 0;
}

const countLine = (text, line) => text.split("\n").filter((l) => l === line).length;

// Land the remaining segments the way the runner does: the untyped rest of the
// lead separator, then every later segment whole.
function landRest(segs, at, leadTyped, existing) {
  let out = existing;
  for (let k = at; k < segs.length; k++) out += (k === at ? segs[k].sep.slice(leadTyped) : segs[k].sep) + segs[k].body;
  return out;
}

for (const lang of LANGS) {
  const sandbox = fs.readFileSync(path.join(MATRIX, lang.file), "utf8");
  const segs = planFileWalk(sandbox, lang.spec());
  const n = segs.length;
  const label = `${lang.name} (${n} segments)`;
  // Cases that need a boundary between two segments cannot run on a one-segment
  // file; they skip with the reason in the report rather than pass vacuously.
  const multi = n >= 2 ? {} : { skip: `corpus file cuts into ${n} segment; no inner boundary to resume at` };

  test(`${label}: segments reproduce the corpus file byte-exact`, () => {
    assert.strictEqual(prefix(segs, n), sandbox);
  });

  test(`${label}: empty target resumes at 0 with nothing typed`, () => {
    assert.deepStrictEqual(resumeWalk(segs, ""), { at: 0, leadTyped: 0 });
  });

  test(`${label}: every exact boundary prefix resumes at its boundary, leadTyped 0`, () => {
    for (let k = 1; k <= n; k++) {
      const got = resumeWalk(segs, prefix(segs, k));
      assert.deepStrictEqual(got, { at: k, leadTyped: 0 }, `k=${k}`);
      assert.strictEqual(landRest(segs, k, got.leadTyped, prefix(segs, k)), sandbox, `k=${k}: landing the rest reproduces the sandbox`);
    }
  });

  test(`${label}: a human line inside or between landed segments keeps the same boundary`, () => {
    for (let k = 1; k <= n; k++) {
      const p = prefix(segs, k);
      const lineCount = p.split("\n").length;
      // Every line position strictly inside the landed bytes (before the last line).
      for (let i = 0; i < lineCount - 1; i++) {
        const existing = insertLine(p, i, lang.note);
        const got = resumeWalk(segs, existing);
        assert.ok(got, `k=${k} i=${i}: resume refused a whole added line`);
        assert.strictEqual(got.at, k, `k=${k} i=${i}`);
        if (k === n) assert.strictEqual(got.leadTyped, 0, `k=${k} i=${i}: leadTyped is 0 at the end`);
        else assert.strictEqual(got.leadTyped, expectedLeadTyped(segs[k].sep, prefix(segs, k), existing), `k=${k} i=${i}: leadTyped`);
      }
    }
  });

  for (const trailingNewline of [false, true]) {
    test(`${label}: a human line appended after the landed boundary (${trailingNewline ? "with" : "without"} trailing newline) resumes there and lands the rest once`, multi, (t) => {
      let checked = 0;
      for (let k = 1; k < n; k++) {
        // An unterminated line typed onto the empty line after a newline-ending
        // boundary leaves no whole blank line where P_k's last line was: outside
        // the contract, so not asserted here.
        if (!trailingNewline && prefix(segs, k).endsWith("\n")) continue;
        checked++;
        const existing = appendLine(prefix(segs, k), lang.note, trailingNewline);
        const got = resumeWalk(segs, existing);
        assert.ok(got, `k=${k}: resume refused an appended whole line`);
        assert.strictEqual(got.at, k, `k=${k}`);
        assert.strictEqual(got.leadTyped, expectedLeadTyped(segs[k].sep, prefix(segs, k), existing), `k=${k}: leadTyped`);
        const result = landRest(segs, got.at, got.leadTyped, existing);
        assert.strictEqual(landedWithAdditions(sandbox, result), true, `k=${k}: finished file must be sandbox plus additions`);
        assert.strictEqual(countLine(result, lang.note), 1, `k=${k}: the human line appears exactly once`);
      }
      if (checked === 0) t.skip("every boundary ends with a newline; no unterminated append is in contract");
    });
  }

  test(`${label}: lead separator already typed after a boundary resumes with leadTyped = sep length`, multi, () => {
    let checked = 0;
    for (let k = 1; k < n; k++) {
      if (segs[k].sep === "") continue;
      checked++;
      const existing = prefix(segs, k) + segs[k].sep;
      const got = resumeWalk(segs, existing);
      assert.deepStrictEqual(got, { at: k, leadTyped: segs[k].sep.length }, `k=${k}`);
      assert.strictEqual(landRest(segs, k, got.leadTyped, existing), sandbox, `k=${k}: landing the rest reproduces the sandbox`);
    }
    assert.ok(checked > 0, "no segment after the first has a separator");
  });

  test(`${label}: the whole file plus human lines is fully landed`, () => {
    const lineCount = sandbox.split("\n").length;
    for (let i = 0; i < lineCount; i++) {
      const target = insertLine(sandbox, i, lang.note);
      assert.deepStrictEqual(resumeWalk(segs, target), { at: n, leadTyped: 0 }, `i=${i}`);
      assert.strictEqual(landedWithAdditions(sandbox, target), true, `i=${i}`);
    }
    // Appended newline-terminated. (Unterminated after a newline-ending file
    // leaves no whole line for the sandbox's final empty element: out of contract.)
    const target = appendLine(sandbox, lang.note, true);
    assert.deepStrictEqual(resumeWalk(segs, target), { at: n, leadTyped: 0 }, "appended");
    assert.strictEqual(landedWithAdditions(sandbox, target), true, "appended");
    assert.strictEqual(landedWithAdditions(sandbox, sandbox), true, "identical bytes");
  });

  test(`${label}: an altered landed line never resumes past the segment holding it`, () => {
    // The altered line is chosen unique in the whole sandbox (trimmed), so no
    // other sandbox line can stand in for it.
    const trimmedAll = sandbox.split("\n").map((l) => l.trim());
    let checked = 0;
    for (let j = 0; j < n; j++) {
      const bodyLines = segs[j].body.split("\n");
      const idx = bodyLines.findIndex((l) => l.trim() !== "" && trimmedAll.filter((t) => t === l.trim()).length === 1);
      if (idx < 0) continue;
      checked++;
      const altered = bodyLines.slice();
      altered[idx] = altered[idx] + " x";
      const alteredSegs = segs.slice();
      alteredSegs[j] = { sep: segs[j].sep, body: altered.join("\n") };
      for (const k of new Set([j + 1, n])) {
        const existing = prefix(alteredSegs, k);
        const got = resumeWalk(segs, existing);
        if (got !== undefined) assert.ok(got.at <= j, `j=${j} k=${k}: claimed at=${got.at} past the altered segment`);
      }
      assert.strictEqual(landedWithAdditions(sandbox, prefix(alteredSegs, n)), false, `j=${j}: altered file is not sandbox plus additions`);
    }
    assert.ok(checked > 0, "no segment has a sandbox-unique line to alter");
  });

  test(`${label}: the next segment's first line typed by hand refuses to resume`, multi, () => {
    let checked = 0;
    for (let k = 1; k < n; k++) {
      const nonBlank = segs[k].body.split("\n").filter((l) => l.trim() !== "");
      // A single-line body typed in full is a real boundary, not a partial landing.
      if (nonBlank.length < 2) continue;
      checked++;
      const existing = prefix(segs, k) + segs[k].sep + nonBlank[0];
      assert.strictEqual(resumeWalk(segs, existing), undefined, `k=${k}: partial next segment`);
      const withNewline = existing + "\n";
      assert.strictEqual(resumeWalk(segs, withNewline), undefined, `k=${k}: partial next segment, newline-terminated`);
    }
    assert.ok(checked > 0, "no segment after the first has two non-blank lines");
  });

  test(`${label}: a foreign file refuses to resume and is not landed`, () => {
    const foreign = "zzz unrelated content\nqqq other bytes\n";
    assert.strictEqual(resumeWalk(segs, foreign), undefined);
    assert.strictEqual(landedWithAdditions(sandbox, foreign), false);
    assert.strictEqual(resumeWalk(segs, lang.note + "\n"), undefined, "only a human line, nothing landed");
  });
}

test("landedWithAdditions: empty sandbox matches only an empty target", () => {
  assert.strictEqual(landedWithAdditions("", ""), true);
  assert.strictEqual(landedWithAdditions("", "// human note\n"), false);
  assert.strictEqual(landedWithAdditions("", "x"), false);
});

test("landedWithAdditions: a missing sandbox line is not landed", () => {
  const sandbox = "fn a() {\n    one();\n    two();\n}\n";
  assert.strictEqual(landedWithAdditions(sandbox, "fn a() {\n    one();\n}\n"), false);
  assert.strictEqual(landedWithAdditions(sandbox, "fn a() {\n    // human note\n    one();\n    two();\n}\n"), true);
  assert.strictEqual(landedWithAdditions(sandbox, "fn a() {\n    one();  // human note\n    two();\n}\n"), false, "a trailing comment alters a sandbox line");
});
