// Unit tests for the guide runner's cursor-positioning helpers.
//
// A real replay must bring the human to the spot, not assume they're there. Two
// pure pieces back that: separatorToInsert (land a created symbol on a fresh,
// blank-separated line at end-of-file) and findFunctionByName (park the cursor on
// the existing symbol a modify/delete step touches). The vscode glue around them
// isn't headless-testable; these pin the logic that is.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const sepBundle = path.join(__dirname, ".insertion.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/insertion.ts")],
  bundle: true,
  outfile: sepBundle,
  format: "cjs",
  platform: "node",
});
const { separatorToInsert } = require(sepBundle);

const walkBundle = path.join(__dirname, ".walk-byname.bundle.cjs");
fs.writeFileSync(
  path.join(__dirname, ".walk-byname.entry.ts"),
  `export { parseRoot } from "../src/disclosure/diff";\n` +
    `export { findFunctionByName } from "../src/disclosure/walk";\n`,
);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, ".walk-byname.entry.ts")],
  bundle: true,
  outfile: walkBundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust"],
});
const { parseRoot, findFunctionByName } = require(walkBundle);

test.after(() => {
  fs.rmSync(sepBundle, { force: true });
  fs.rmSync(walkBundle, { force: true });
  fs.rmSync(path.join(__dirname, ".walk-byname.entry.ts"), { force: true });
});

// --- separatorToInsert: always end on a blank, separated line ---------------

const SEP_CASES = [
  { name: "no trailing newline → two", text: "fn a() {}", want: "\n\n" },
  { name: "one trailing newline → one more", text: "fn a() {}\n", want: "\n" },
  { name: "already blank-separated → none", text: "fn a() {}\n\n", want: "" },
  { name: "more than enough → none", text: "fn a() {}\n\n\n", want: "" },
  { name: "empty file → none (land as-is)", text: "", want: "" },
  { name: "whitespace-only file → none", text: "\n\n", want: "" },
  { name: "comment + blank line (the stub) → none", text: "// replay target\n\n", want: "" },
];

for (const c of SEP_CASES) {
  test(`separatorToInsert: ${c.name}`, () => {
    assert.strictEqual(separatorToInsert(c.text), c.want);
  });
}

test("separatorToInsert: applying it always yields a blank separator line", () => {
  for (const c of SEP_CASES) {
    if (c.text.replace(/\s/g, "").length === 0) continue; // empty files land as-is
    const result = c.text + separatorToInsert(c.text);
    assert.match(result, /\n\n$/, `"${c.text}" should end blank-separated`);
  }
});

// --- findFunctionByName: locate the symbol a modify/delete touches ----------

const SRC = `fn alpha() -> u32 {\n    1\n}\n\nfn beta(x: u32) -> u32 {\n    x + 1\n}\n\nfn gamma() {}\n`;

test("findFunctionByName: locates a named function and ignores others", () => {
  const root = parseRoot(SRC);
  const beta = findFunctionByName(root, SRC, "beta");
  assert.ok(beta, "beta should be found");
  assert.strictEqual(SRC.slice(beta.startIndex, beta.startIndex + 7), "fn beta");
});

test("findFunctionByName: returns null for an absent symbol", () => {
  const root = parseRoot(SRC);
  assert.strictEqual(findFunctionByName(root, SRC, "delta"), null);
});

test("findFunctionByName: the located node starts exactly at the symbol's bytes", () => {
  const root = parseRoot(SRC);
  const gamma = findFunctionByName(root, SRC, "gamma");
  assert.ok(gamma);
  assert.strictEqual(SRC.slice(gamma.startIndex, gamma.endIndex), "fn gamma() {}");
});
