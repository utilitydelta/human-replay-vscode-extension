// Unit tests for the divergence-recovery ghost geometry
// (src/disclosure/recoveryGhost.ts).
//
// This is the path that takes over once the human authors their own code mid-walk:
// the next planned node is offered as an INSERT at the cursor, indented to the
// cursor column. The bug it fixes was a total ghost collapse — one hand-edit killed
// every remaining ghost because the walk re-anchored to a recomputed point instead
// of to the cursor. The invariants here pin the geometry: nothing is invented (the
// node's own text survives verbatim), the indentation matches the cursor column, and
// the post-accept caret lands where the next step continues — inside the braces for a
// container (the descend), after the text for a leaf.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".recovery-ghost.bundle.cjs");
const entry = path.join(__dirname, ".recovery-ghost.entry.ts");
fs.writeFileSync(entry, `export { buildRecoveryGhost } from "../src/disclosure/recoveryGhost";\n`);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
});
const { buildRecoveryGhost } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const leaf = (bareText) => ({ kind: "leaf", bareText });
const container = (bareText) => ({ kind: "container", bareText });

// Apply the ghost the way VS Code would: splice `text` into `lineText` at `character`,
// returning the full resulting buffer and the absolute caret position.
const apply = (lineText, character, g) => {
  const buffer = lineText.slice(0, character) + g.text + lineText.slice(character);
  return { buffer, caretAbs: character + g.caret };
};

test("leaf on a blank indented line: lands directly, no leading newline, caret at end", () => {
  const g = buildRecoveryGhost("        ", 8, leaf("let x = foo();"));
  assert.strictEqual(g.text, "let x = foo();");
  assert.strictEqual(g.caret, g.text.length, "caret lands after the leaf");
  assert.ok(!g.text.startsWith("\n"), "no leading newline on a blank line");
});

test("leaf at end of a code line: leading newline + matching indent, caret at end", () => {
  const lineText = "    let a = 1;";
  const g = buildRecoveryGhost(lineText, lineText.length, leaf("let x = foo();"));
  assert.strictEqual(g.text, "\n    let x = foo();");
  assert.strictEqual(g.caret, g.text.length);
  const { buffer } = apply(lineText, lineText.length, g);
  assert.strictEqual(buffer, "    let a = 1;\n    let x = foo();", "node opens the next line at the same indent");
});

test("ground truth: a multi-line leaf survives verbatim, continuation lines indented to the cursor", () => {
  const bare = "match x {\n    A => 1,\n}";
  const g = buildRecoveryGhost("        ", 8, leaf(bare));
  // Strip the per-line base indent off continuation lines → original bareText back.
  const lines = g.text.split("\n");
  const restored = lines.map((l, i) => (i === 0 ? l : l.slice(8))).join("\n");
  assert.strictEqual(restored, bare, "nothing invented; only base indent added");
});

test("container: opens a blank inner line and the caret descends onto it", () => {
  const g = buildRecoveryGhost("    ", 4, container("for i in 0..n {\n}"));
  // baseIndent 4 → inner 8: header, blank inner line at col 8, close brace at col 4.
  assert.strictEqual(g.text, "for i in 0..n {\n        \n    }");
  // The caret sits on the blank inner line, at the inner indent column.
  const upToCaret = g.text.slice(0, g.caret);
  const caretLine = upToCaret.split("\n").length - 1;
  const caretCol = g.caret - (upToCaret.lastIndexOf("\n") + 1);
  assert.strictEqual(caretLine, 1, "caret is on the inner line");
  assert.strictEqual(caretCol, 8, "caret is at the inner indent (baseIndent + 4)");
});

test("container at end of a code line: leading newline, close brace back at the base indent", () => {
  const lineText = "    let n = len();";
  const g = buildRecoveryGhost(lineText, lineText.length, container("while go {\n}"));
  assert.strictEqual(g.text, "\n    while go {\n        \n    }");
  const { buffer, caretAbs } = apply(lineText, lineText.length, g);
  assert.strictEqual(buffer, "    let n = len();\n    while go {\n        \n    }");
  assert.strictEqual(buffer[caretAbs - 1], " ", "caret follows the inner indent");
});

test("container with the brace on its own line (C#): the { survives and indents", () => {
  // bareText = header incl. "{" + "\n}". C# headers span two lines; cutting the
  // header at the first newline dropped the brace entirely (the RoundToCents
  // corruption, feedback.md).
  const g = buildRecoveryGhost("    ", 4, container("public static decimal RoundToCents(decimal amount)\n{\n}"));
  assert.strictEqual(g.text, "public static decimal RoundToCents(decimal amount)\n    {\n        \n    }");
  // Caret descends onto the blank inner line, past the brace line.
  const upToCaret = g.text.slice(0, g.caret);
  assert.strictEqual(upToCaret.split("\n").length - 1, 2, "caret is on the inner line below the brace");
  assert.ok(g.text.includes("{"), "the opening brace is in the ghost");
});

test("caret stays within the inserted text for both kinds", () => {
  for (const step of [leaf("a();"), container("if c {\n}")]) {
    const g = buildRecoveryGhost("  ", 2, step);
    assert.ok(g.caret >= 0 && g.caret <= g.text.length, `caret in range for ${step.kind}`);
  }
});
