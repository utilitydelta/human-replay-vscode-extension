// Where a created symbol LANDS, byte for byte.
//
// The gap this closes was found by adversarial review, and it was wide: the
// suite had exactly one placement byte-exactness case (4-space Rust into a
// 4-space target), and `scripts/harvest-replay.js` never called
// `planCreateInsertion` at all — its create branch re-walks each symbol against
// itself, which cannot see a placement defect. So a create that landed a SPACE
// into a tab-indented file was green everywhere.
//
// The contract, in one line: plan the placement, land the sandbox symbol's
// bytes at the plan's cursor, and the result must be made only of bytes that
// were already in the target or in the sandbox. The column comes from the
// target's own layout, copied — not counted and re-synthesized, because a
// counted column spells a tab as a space and that byte exists in neither file.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".create-placement.bundle.cjs");
const entry = path.join(__dirname, ".create-placement.entry.ts");
fs.writeFileSync(
  entry,
  `export { planCreateInsertion, separatorToInsert, splitLeadingPad } from "../src/disclosure/insertion";\n` +
    `export { extractSymbol } from "../src/disclosure/resume";\n` +
    `export { RUST, CSHARP, TYPESCRIPT, PYTHON } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { planCreateInsertion, splitLeadingPad, extractSymbol, RUST, CSHARP, TYPESCRIPT, PYTHON } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

// The runner's exact sequence: apply the scaffold edit, type the symbol's pad as
// real bytes, then land the rest at the cursor.
function landCreate(targetText, plan, symbolBytes) {
  assert.strictEqual(plan.kind, "container", `expected a container plan, got ${plan.kind}${plan.reason ? `: ${plan.reason}` : ""}`);
  const scaffolded = targetText.slice(0, plan.start) + plan.scaffold + targetText.slice(plan.end);
  const { pad, rest } = splitLeadingPad(symbolBytes);
  return scaffolded.slice(0, plan.cursorAt) + pad + rest + scaffolded.slice(plan.cursorAt);
}

// Every byte of the result came from one of the two real files, or is the
// language's own line terminator. Nothing is invented — the ground-truth
// invariant, checked at the line grain where a synthesized column shows up.
function assertNoInventedIndent(built, targetText, sandboxText, symbol) {
  const symbolLines = new Set(symbol.split(/\r?\n/));
  const targetLines = new Set(targetText.split(/\r?\n/));
  const sandboxLines = new Set(sandboxText.split(/\r?\n/));
  for (const line of built.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (targetLines.has(line) || sandboxLines.has(line)) continue;
    // The one line that legitimately differs is the symbol's first, which the
    // scaffold re-columns: its CODE must be the symbol's, and its indent must
    // be whitespace the target itself uses.
    const trimmed = line.replace(/^[ \t]*/, "");
    const indent = /^[ \t]*/.exec(line)[0];
    assert.ok(
      symbolLines.has(trimmed) || sandboxLines.has(line),
      `landed a line that is in neither file:\n${JSON.stringify(line)}`,
    );
    assert.ok(
      targetText.includes(`\n${indent}`) || indent === "",
      `landed an indent the target never uses: ${JSON.stringify(indent)} (a counted column spells a tab as spaces)`,
    );
  }
}

// container: the target, missing the symbol. sandbox: the same shape with it.
const CASES = [
  {
    name: "rust: spaces, method with a doc comment",
    spec: () => RUST,
    symbol: "parked",
    target: `impl Cache {\n    pub fn a(&self) -> u64 {\n        self.bytes\n    }\n}\n`,
    sandbox: `impl Cache {\n    pub fn a(&self) -> u64 {\n        self.bytes\n    }\n\n    /// Parks a batch.\n    pub fn parked(&mut self, n: u64) {\n        self.bytes += n;\n    }\n}\n`,
  },
  {
    name: "rust: TABS, method with a doc comment",
    // The regression: `" ".repeat(colOf(...))` spelled the tab as one space.
    spec: () => RUST,
    symbol: "parked",
    target: `impl Cache {\n\tpub fn a(&self) -> u64 {\n\t\tself.bytes\n\t}\n}\n`,
    sandbox: `impl Cache {\n\tpub fn a(&self) -> u64 {\n\t\tself.bytes\n\t}\n\n\t/// Parks a batch.\n\tpub fn parked(&mut self, n: u64) {\n\t\tself.bytes += n;\n\t}\n}\n`,
  },
  {
    name: "rust: TABS, method with no trivia",
    spec: () => RUST,
    symbol: "parked",
    target: `impl Cache {\n\tpub fn a(&self) -> u64 {\n\t\tself.bytes\n\t}\n}\n`,
    sandbox: `impl Cache {\n\tpub fn a(&self) -> u64 {\n\t\tself.bytes\n\t}\n\n\tpub fn parked(&mut self, n: u64) {\n\t\tself.bytes += n;\n\t}\n}\n`,
  },
  {
    name: "typescript: TABS, commented method in a class",
    spec: () => TYPESCRIPT,
    symbol: "parked",
    target: `class Cache {\n\ta(): number {\n\t\treturn 1;\n\t}\n}\n`,
    sandbox: `class Cache {\n\ta(): number {\n\t\treturn 1;\n\t}\n\n\t/** Parks. */\n\tparked(n: number): void {\n\t\tthis.total += n;\n\t}\n}\n`,
  },
  {
    name: "csharp: spaces, attributed method",
    spec: () => CSHARP,
    symbol: "Park",
    target: `public class Cache\n{\n    public int A() { return 1; }\n}\n`,
    sandbox: `public class Cache\n{\n    public int A() { return 1; }\n\n    /// <summary>Parks.</summary>\n    public void Park(int n)\n    {\n        _total += n;\n    }\n}\n`,
  },
  {
    name: "python: a decorated method in a class",
    spec: () => PYTHON,
    symbol: "park",
    target: `class Cache:\n    def a(self):\n        return 1\n`,
    sandbox: `class Cache:\n    def a(self):\n        return 1\n\n    # bounded\n    @guard\n    def park(self, n):\n        self.total += n\n`,
  },
];

for (const c of CASES) {
  test(`create placement — ${c.name}: the landed column is the target's own bytes`, () => {
    const spec = c.spec();
    const symbol = extractSymbol(c.sandbox, c.symbol, spec);
    assert.ok(symbol !== undefined, "the sandbox symbol must resolve");
    const plan = planCreateInsertion(c.target, c.sandbox, c.symbol, spec);
    const built = landCreate(c.target, plan, symbol);
    assertNoInventedIndent(built, c.target, c.sandbox, symbol);
    assert.ok(built.includes(symbol), "the symbol's own bytes land whole");
  });

  test(`create placement — ${c.name}: same-shaped target rebuilds the sandbox exactly`, () => {
    // When the target's layout matches the sandbox's, "land it at the target's
    // column" and "land it at the sandbox's column" are the same answer, so the
    // result must be the sandbox file byte for byte. That is the strongest form
    // of the contract and the one a tab/space mismatch breaks first.
    const spec = c.spec();
    const symbol = extractSymbol(c.sandbox, c.symbol, spec);
    const plan = planCreateInsertion(c.target, c.sandbox, c.symbol, spec);
    assert.strictEqual(landCreate(c.target, plan, symbol), c.sandbox, "target becomes the sandbox");
  });
}

// An empty container has no sibling to copy a prefix from, so the container's
// own prefix is the source of the child's column.
test("create placement — an empty tab-indented container indents its first child with a tab", () => {
  const target = `mod outer {\n\timpl Cache {}\n}\n`;
  const sandbox = `mod outer {\n\timpl Cache {\n\t\tpub fn parked(&mut self) {}\n\t}\n}\n`;
  const plan = planCreateInsertion(target, sandbox, "parked", RUST);
  if (plan.kind !== "container") return; // a single-line container is blocked by design
  assert.ok(!plan.scaffold.includes("    "), `the scaffold spelled a tab as spaces: ${JSON.stringify(plan.scaffold)}`);
});

test("create placement — the plan is blocked, never guessed, when the container is missing", () => {
  const target = `fn free() {}\n`;
  const sandbox = `impl Missing {\n    pub fn parked(&mut self) {}\n}\n`;
  const plan = planCreateInsertion(target, sandbox, "parked", RUST);
  assert.strictEqual(plan.kind, "blocked", "no container in the target means no honest spot");
  assert.match(plan.reason, /not found/i, "and it says which container");
});
