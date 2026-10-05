// Blank-line patches — the "Close the file" steps that stopped the replay on a
// "Review hunks" toast for a final newline nobody can see.
//
// The invariant: a patch lands without a gesture only when every byte it adds
// is a blank-line byte and it removes nothing. Every non-blank line must match
// byte for byte, indentation and trailing spaces included, so a Python indent
// change or a whitespace edit inside a line never rides along. A patch that
// only REMOVES blank lines keeps its Tab: those lines may be the human's.
// Applying the hunks of an "adds" patch must reproduce the sandbox exactly.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".blank-patch.bundle.cjs");
const entry = path.join(__dirname, ".blank-patch.entry.ts");
fs.writeFileSync(entry, `export { blankLineDelta, lineDiffSteps } from "../src/disclosure/lineDiff";\n`);
esbuild.buildSync({ entryPoints: [entry], bundle: true, outfile: bundle, format: "cjs", platform: "node", external: ["tree-sitter", "tree-sitter-*", "@tree-sitter-grammars/*"] });
const { blankLineDelta, lineDiffSteps } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const MATRIX = ["matrix-rust.rs", "matrix-typescript.ts.txt", "matrix-tsx.tsx.txt", "matrix-csharp.cs", "matrix-python.py", "matrix-markdown.md", "matrix-css.css", "matrix-html.html"];
const read = (f) => fs.readFileSync(path.join(__dirname, "corpus", "matrix", f), "utf8");

// The runner's landing: every hunk applied in one edit, old coordinates.
function land(live, sandbox) {
  let out = "";
  let at = 0;
  for (const h of lineDiffSteps(live, sandbox)) {
    out += live.slice(at, h.start) + h.replacement;
    at = h.end;
  }
  return out + live.slice(at);
}

for (const f of MATRIX) {
  const sandbox = read(f);
  const lines = sandbox.split("\n");
  const blankAt = lines.findIndex((l, i) => i > 0 && l === "");
  const codeAt = lines.findIndex((l) => /^\s+\S/.test(l));

  test(`${f}: a missing final newline is "adds" and lands byte-exact`, () => {
    const live = sandbox.replace(/\n$/, "");
    assert.strictEqual(blankLineDelta(live, sandbox), "adds");
    assert.strictEqual(land(live, sandbox), sandbox);
  });

  test(`${f}: a missing blank line between items is "adds" and lands byte-exact`, () => {
    assert.ok(blankAt > 0, "the corpus has an inner blank line");
    const live = [...lines.slice(0, blankAt), ...lines.slice(blankAt + 1)].join("\n");
    assert.strictEqual(blankLineDelta(live, sandbox), "adds");
    assert.strictEqual(land(live, sandbox), sandbox);
  });

  test(`${f}: an extra blank line is "removes", never auto-landed`, () => {
    const live = [...lines.slice(0, blankAt), "", ...lines.slice(blankAt)].join("\n");
    assert.strictEqual(blankLineDelta(live, sandbox), "removes");
  });

  test(`${f}: an indentation change on a code line never qualifies`, () => {
    assert.ok(codeAt >= 0, "the corpus has an indented line");
    const live = lines.map((l, i) => (i === codeAt ? l.slice(1) : l)).join("\n");
    assert.strictEqual(blankLineDelta(live, sandbox), undefined);
  });

  test(`${f}: a trailing-space change never qualifies`, () => {
    const live = lines.map((l, i) => (i === codeAt ? l + " " : l)).join("\n");
    assert.strictEqual(blankLineDelta(live, sandbox), undefined);
  });

  test(`${f}: a blank line added in one place and removed in another is mixed, not either`, () => {
    const last = lines.length - 2;
    const live = [...lines.slice(0, blankAt), ...lines.slice(blankAt + 1, last), "", ...lines.slice(last)].join("\n");
    assert.strictEqual(blankLineDelta(live, sandbox), undefined);
  });
}

test("identical files are not a blank patch", () => {
  assert.strictEqual(blankLineDelta("a\n", "a\n"), undefined);
});

test("CRLF: a missing final CRLF is adds; a mixed-EOL code line is not", () => {
  assert.strictEqual(blankLineDelta("a\r\nb", "a\r\nb\r\n"), undefined, "the last line gains a \\r, a code-line byte");
  assert.strictEqual(blankLineDelta("a\r\nb\r\n", "a\r\nb\r\n\r\n"), "adds");
  assert.strictEqual(land("a\r\nb\r\n", "a\r\nb\r\n\r\n"), "a\r\nb\r\n\r\n");
});

test("a whitespace-only line gaining spaces is adds (still blank), and lands byte-exact", () => {
  assert.strictEqual(blankLineDelta("a\n\nb\n", "a\n\n  \nb\n"), "adds");
  assert.strictEqual(land("a\n\nb\n", "a\n\n  \nb\n"), "a\n\n  \nb\n");
});

test("a blank line's own spaces changing is neither: the normal pause handles it", () => {
  assert.strictEqual(blankLineDelta("a\n  \nb\n", "a\n\nb\n"), undefined);
  assert.strictEqual(blankLineDelta("a\n \nb\n", "a\n\t\nb\n"), undefined);
});
