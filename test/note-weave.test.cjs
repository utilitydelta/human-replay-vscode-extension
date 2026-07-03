// Unit tests for the FIM note weave (src/noteWeave.ts).
//
// Replay notes are UI bubbles, not buffer bytes, so without the weave the FIM
// model can never see them (the "filter out anything over 100 dollars" note
// that steered nothing). The invariants: each note lands as a comment line
// above its anchor with plausible indentation, the buffer-borne lines survive
// byte-exact around it, notes below the cursor are dropped, and no notes means
// the prefix passes through untouched.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".note-weave.bundle.cjs");
const entry = path.join(__dirname, ".note-weave.entry.ts");
fs.writeFileSync(entry, `export { weaveNotes, noteToken } from "../src/noteWeave";\n`);
esbuild.buildSync({ entryPoints: [entry], bundle: true, outfile: bundle, format: "cjs", platform: "node" });
const { weaveNotes, noteToken } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const PREFIX = [
  "public static void Main()",
  "{",
  '    cart.Add(new InventoryItem("Laptop", 2799.99m, 1));',
  "",
  "    ",
].join("\n");

test("a note lands as a comment line above its anchor, indented like the code", () => {
  const woven = weaveNotes(PREFIX, [{ line0: 2, text: "need to filter out anything over 100 dollars" }], "//");
  const lines = woven.split("\n");
  assert.strictEqual(lines[2], "    // need to filter out anything over 100 dollars");
  assert.strictEqual(lines[3], '    cart.Add(new InventoryItem("Laptop", 2799.99m, 1));', "the anchor line follows, byte-exact");
});

test("a note on a blank line borrows the nearest code indentation above", () => {
  const woven = weaveNotes(PREFIX, [{ line0: 3, text: "sum it up" }], "//");
  assert.strictEqual(woven.split("\n")[3], "    // sum it up");
});

test("multiple notes weave without corrupting each other's anchors", () => {
  const woven = weaveNotes(PREFIX, [
    { line0: 0, text: "entry point" },
    { line0: 2, text: "too expensive" },
  ], "//");
  const lines = woven.split("\n");
  assert.strictEqual(lines[0], "// entry point");
  assert.strictEqual(lines[3], "    // too expensive");
  assert.strictEqual(lines[4], '    cart.Add(new InventoryItem("Laptop", 2799.99m, 1));');
});

test("notes below the cursor are dropped; no notes passes through byte-exact", () => {
  assert.strictEqual(weaveNotes(PREFIX, [{ line0: 99, text: "later" }], "//"), PREFIX);
  assert.strictEqual(weaveNotes(PREFIX, [], "//"), PREFIX);
});

test("comment tokens follow the language, wrapped pairs included", () => {
  assert.strictEqual(weaveNotes("x = 1", [{ line0: 0, text: "n" }], ...(() => { const t = noteToken("python"); return [t.open, t.close]; })()).split("\n")[0], "# n");
  const css = noteToken("css");
  assert.strictEqual(weaveNotes("a {}", [{ line0: 0, text: "n" }], css.open, css.close).split("\n")[0], "/* n */");
  assert.strictEqual(noteToken("csharp").open, "//");
});
