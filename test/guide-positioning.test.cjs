// Unit tests for the guide runner's cursor-positioning helpers.
//
// A real replay must bring the human to the spot, not assume they're there. The
// pure pieces backing that: planCreateInsertion (a fresh create lands where the
// sandbox says the symbol lives — inside the matching container when nested, at
// end-of-file when top-level, blocked when the container is missing),
// separatorToInsert (the end-of-file case lands on a fresh, blank-separated
// line), and findFunctionByName (park the cursor on the existing symbol a
// modify/delete step touches). The vscode glue around them isn't
// headless-testable; these pin the logic that is.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");
const Parser = require("tree-sitter");
const Rust = require("tree-sitter-rust");

const EXTERNALS = ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown"];

const sepBundle = path.join(__dirname, ".insertion.bundle.cjs");
fs.writeFileSync(
  path.join(__dirname, ".insertion.entry.ts"),
  `export { separatorToInsert, planCreateInsertion } from "../src/disclosure/insertion";\n` +
    `export { RUST, TYPESCRIPT, PYTHON, MARKDOWN } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, ".insertion.entry.ts")],
  bundle: true,
  outfile: sepBundle,
  format: "cjs",
  platform: "node",
  external: EXTERNALS,
});
const { separatorToInsert, planCreateInsertion, RUST, TYPESCRIPT, PYTHON, MARKDOWN } = require(sepBundle);

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
  external: EXTERNALS,
});
const { parseRoot, findFunctionByName } = require(walkBundle);

test.after(() => {
  fs.rmSync(sepBundle, { force: true });
  fs.rmSync(walkBundle, { force: true });
  fs.rmSync(path.join(__dirname, ".insertion.entry.ts"), { force: true });
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

// --- planCreateInsertion: a nested create lands inside its container ---------
// The step-1.3 regression: a method created inside an impl was appended at
// end-of-file, outside the impl — a `&mut self` fn at top level doesn't compile.
// The plan must come from real bytes on both sides: the sandbox names the
// container and the preceding sibling; the target says where they live today.

const rustParser = new Parser();
rustParser.setLanguage(Rust);

// Apply a plan the way the runner does — scaffold edit, then the symbol's bytes
// land at the cursor — and return the resulting buffer.
function landCreate(targetText, plan, symbolBytes) {
  assert.strictEqual(plan.kind, "container");
  const scaffolded = targetText.slice(0, plan.start) + plan.scaffold + targetText.slice(plan.end);
  return scaffolded.slice(0, plan.cursorAt) + symbolBytes + scaffolded.slice(plan.cursorAt);
}

const SANDBOX_RS = `pub struct Cache {\n    bytes: u64,\n}\n\nimpl Cache {\n    pub fn a(&self) -> u64 {\n        self.bytes\n    }\n\n    pub fn parked(&mut self, n: u64) {\n        self.bytes += n;\n    }\n\n    pub fn b(&self) -> bool {\n        self.bytes > 0\n    }\n}\n\nfn free_fn() {}\n`;

const PLACEMENT = [
  {
    name: "method lands after its preceding sandbox sibling, inside the impl",
    target: `pub struct Cache {\n    bytes: u64,\n}\n\nimpl Cache {\n    pub fn a(&self) -> u64 {\n        self.bytes\n    }\n\n    pub fn b(&self) -> bool {\n        self.bytes > 0\n    }\n}\n`,
    symbol: "parked",
    // `parked` follows `a` in the sandbox, so it must land between a and b.
    expectOrder: ["fn a", "fn parked", "fn b"],
  },
  {
    name: "missing preceding sibling: backwards scan anchors on the next one that exists",
    target: `impl Cache {\n    pub fn a(&self) -> u64 {\n        self.bytes\n    }\n}\n`,
    // sandbox order is a, parked, b — with only `a` in the target, `b`'s absence
    // must not derail placement of... use symbol b whose predecessor `parked`
    // is absent but `a` is present.
    symbol: "b",
    expectOrder: ["fn a", "fn b"],
  },
  {
    name: "no named predecessor in the target: lands after the container's last item",
    target: `impl Cache {\n    pub fn zeta(&self) -> u8 {\n        0\n    }\n}\n`,
    symbol: "parked",
    expectOrder: ["fn zeta", "fn parked"],
  },
];

for (const { name, target, symbol, expectOrder } of PLACEMENT) {
  test(`planCreateInsertion: ${name}`, () => {
    const plan = planCreateInsertion(target, SANDBOX_RS, symbol, RUST);
    const symbolBytes = SANDBOX_RS.match(new RegExp(`pub fn ${symbol}[^]*?\\n    \\}`))[0];
    const built = landCreate(target, plan, symbolBytes);
    assert.ok(!rustParser.parse(built).rootNode.hasError, `must parse clean:\n${built}`);
    let pos = -1;
    for (const marker of expectOrder) {
      const at = built.indexOf(marker);
      assert.ok(at > pos, `${marker} must appear after the previous marker`);
      pos = at;
    }
    // Inside the impl: the method starts before the impl's closing brace.
    assert.ok(built.indexOf(`fn ${symbol}`) < built.lastIndexOf("}"), "must land inside the impl");
    // At child indent: the landed line starts with exactly four spaces.
    const line = built.split("\n").find((l) => l.includes(`fn ${symbol}`));
    assert.match(line, /^    pub fn /, "must land at the impl's child indent");
  });
}

test("planCreateInsertion: documented method — cursor parks at column 0, symbol supplies its own pad", () => {
  // extractSymbol starts a documented symbol at its LINE START, pad included; a
  // scaffold pad on top would double-indent the first line.
  const sandbox = `impl Cache {\n    pub fn a(&self) -> u64 {\n        self.bytes\n    }\n\n    /// Parks a batch.\n    #[inline]\n    pub fn parked(&mut self, n: u64) {\n        self.bytes += n;\n    }\n}\n`;
  const target = `impl Cache {\n    pub fn a(&self) -> u64 {\n        self.bytes\n    }\n}\n`;
  const plan = planCreateInsertion(target, sandbox, "parked", RUST);
  assert.strictEqual(plan.kind, "container");
  assert.strictEqual(plan.scaffold, "\n\n", "no scaffold pad — the symbol carries its own");
  const symbolBytes = "    /// Parks a batch.\n    #[inline]\n    pub fn parked(&mut self, n: u64) {\n        self.bytes += n;\n    }";
  const built = landCreate(target, plan, symbolBytes);
  assert.strictEqual(built, sandbox, "target becomes byte-identical to the sandbox");
});

test("planCreateInsertion: the landed method is byte-identical to the sandbox symbol at depth", () => {
  const target = `impl Cache {\n    pub fn a(&self) -> u64 {\n        self.bytes\n    }\n}\n`;
  const plan = planCreateInsertion(target, SANDBOX_RS, "parked", RUST);
  const symbolBytes = "pub fn parked(&mut self, n: u64) {\n        self.bytes += n;\n    }";
  const built = landCreate(target, plan, symbolBytes);
  assert.ok(built.includes(`    pub fn parked(&mut self, n: u64) {\n        self.bytes += n;\n    }\n}`), `ground truth bytes at depth:\n${built}`);
});

// --- top-level symbols: the file root is a container like any other ----------

test("planCreateInsertion: top-level symbol lands in sandbox order among live siblings", () => {
  const sandbox = `fn alpha() {}\n\nfn parked() {\n    1;\n}\n\nfn omega() {}\n`;
  const target = `fn alpha() {}\n\nfn omega() {}\n`;
  const plan = planCreateInsertion(target, sandbox, "parked", RUST);
  const built = landCreate(target, plan, "fn parked() {\n    1;\n}");
  assert.strictEqual(built, `fn alpha() {}\n\nfn parked() {\n    1;\n}\n\nfn omega() {}\n`);
});

test("planCreateInsertion: top-level symbol with no live predecessor falls to end-of-file", () => {
  const plan = planCreateInsertion(`fn unrelated_name() {}\n`, SANDBOX_RS, "free_fn", RUST);
  assert.strictEqual(plan.kind, "top-level");
});

// --- duplicate container headers: member overlap disambiguates ---------------

test("planCreateInsertion: two impls with the same header — the one sharing members wins", () => {
  // Rust allows many `impl X` blocks; the sandbox method's siblings say which one.
  const sandbox = `impl Cache {\n    fn far(&self) {}\n}\n\nimpl Cache {\n    pub fn a(&self) -> u64 {\n        self.bytes\n    }\n\n    pub fn parked(&mut self) {}\n}\n`;
  const target = `impl Cache {\n    fn far(&self) {}\n}\n\nimpl Cache {\n    pub fn a(&self) -> u64 {\n        self.bytes\n    }\n}\n`;
  const plan = planCreateInsertion(target, sandbox, "parked", RUST);
  const built = landCreate(target, plan, "pub fn parked(&mut self) {}");
  assert.ok(!rustParser.parse(built).rootNode.hasError, `must parse clean:\n${built}`);
  assert.ok(
    built.includes("pub fn a(&self) -> u64 {\n        self.bytes\n    }\n\n    pub fn parked"),
    `lands in the impl that holds \`a\`, not the first impl:\n${built}`,
  );
});

// --- CRLF targets: scaffolds match the file's line endings -------------------

test("planCreateInsertion: CRLF target gets a CRLF scaffold (no mixed endings)", () => {
  const target = `impl Cache {\r\n    pub fn a(&self) -> u64 {\r\n        self.bytes\r\n    }\r\n}\r\n`;
  const plan = planCreateInsertion(target, SANDBOX_RS, "parked", RUST);
  assert.strictEqual(plan.kind, "container");
  assert.strictEqual(plan.scaffold, "\r\n\r\n    ", "scaffold uses the target's CRLF");
  const built = landCreate(target, plan, "pub fn parked(&mut self, n: u64) {}");
  assert.ok(!/[^\r]\n/.test(built.replace(/\r\n/g, "")), "no lone LF introduced");
  assert.ok(built.includes("    }\r\n\r\n    pub fn parked"), `lands on its own CRLF-separated line:\n${built}`);
});

test("separatorToInsert: CRLF file gets CRLF separators", () => {
  assert.strictEqual(separatorToInsert("fn a() {}\r\n"), "\r\n");
  assert.strictEqual(separatorToInsert("fn a() {}\r\n\r\n"), "");
});

// --- markdown: top-level sections order; nested subsections stay honest ------

test("planCreateInsertion: markdown root-level sections land in sandbox order", () => {
  // Sections nest by heading level; same-level siblings at the ROOT order fine.
  const sandbox = `## Setup\n\nSteps.\n\n## Parked\n\nNew section.\n\n## Usage\n\nHow.\n`;
  const target = `## Setup\n\nSteps.\n\n## Usage\n\nHow.\n`;
  const plan = planCreateInsertion(target, sandbox, "Parked", MARKDOWN);
  assert.strictEqual(plan.kind, "container");
  const built = landCreate(target, plan, "## Parked\n\nNew section.");
  assert.ok(built.indexOf("## Parked") > built.indexOf("## Setup"), "after Setup");
  assert.ok(built.indexOf("## Parked") < built.indexOf("## Usage"), "before Usage");
});

test("planCreateInsertion: markdown section nested under a heading falls to end-of-file, never a wrong spot", () => {
  // Under `# Title` every ## is the H1 section's child, not the root's — with no
  // section-container mapping the only honest spot is end-of-file (visible miss).
  const sandbox = `# Title\n\nIntro.\n\n## Setup\n\nSteps.\n\n## Parked\n\nNew.\n\n## Usage\n`;
  const target = `# Title\n\nIntro.\n\n## Setup\n\nSteps.\n\n## Usage\n`;
  const plan = planCreateInsertion(target, sandbox, "Parked", MARKDOWN);
  assert.strictEqual(plan.kind, "top-level");
});

test("planCreateInsertion: container missing from the target blocks — never guesses", () => {
  const plan = planCreateInsertion(`fn unrelated() {}\n`, SANDBOX_RS, "parked", RUST);
  assert.strictEqual(plan.kind, "blocked");
  assert.match(plan.reason, /impl Cache/, "the reason names the missing container");
});

test("planCreateInsertion: empty container body opens between the braces", () => {
  const target = `impl Cache {}\n`;
  const plan = planCreateInsertion(target, SANDBOX_RS, "parked", RUST);
  const symbolBytes = "pub fn parked(&mut self, n: u64) {\n        self.bytes += n;\n    }";
  const built = landCreate(target, plan, symbolBytes);
  assert.ok(!rustParser.parse(built).rootNode.hasError, `must parse clean:\n${built}`);
  assert.ok(built.includes("impl Cache {\n    pub fn parked"), "opens the body at child indent");
});

test("planCreateInsertion: nested container chain (mod > impl) resolves level by level", () => {
  const sandbox = `mod cache {\n    impl Cache {\n        pub fn a(&self) {}\n\n        pub fn parked(&mut self) {}\n    }\n}\n\nimpl Cache {\n    fn decoy(&self) {}\n}\n`;
  const target = `mod cache {\n    impl Cache {\n        pub fn a(&self) {}\n    }\n}\n\nimpl Cache {\n    fn decoy(&self) {}\n}\n`;
  const plan = planCreateInsertion(target, sandbox, "parked", RUST);
  const built = landCreate(target, plan, "pub fn parked(&mut self) {}");
  assert.ok(!rustParser.parse(built).rootNode.hasError, `must parse clean:\n${built}`);
  assert.ok(built.includes("pub fn a(&self) {}\n\n        pub fn parked(&mut self) {}"), `lands in the mod's impl, not the decoy:\n${built}`);
});

test("planCreateInsertion: TypeScript class method lands inside the class", () => {
  const sandbox = `export class Store {\n  get(k: string): number {\n    return this.m[k];\n  }\n\n  put(k: string, v: number): void {\n    this.m[k] = v;\n  }\n}\n`;
  const target = `export class Store {\n  get(k: string): number {\n    return this.m[k];\n  }\n}\n`;
  const plan = planCreateInsertion(target, sandbox, "put", TYPESCRIPT);
  const built = landCreate(target, plan, "put(k: string, v: number): void {\n    this.m[k] = v;\n  }");
  assert.ok(built.includes("  }\n\n  put(k: string, v: number): void {"), `lands after get, at class child indent:\n${built}`);
});

test("planCreateInsertion: Python class method lands inside the class (whole-symbol path)", () => {
  const sandbox = `class Store:\n    def get(self, k):\n        return self.m[k]\n\n    def put(self, k, v):\n        self.m[k] = v\n`;
  const target = `class Store:\n    def get(self, k):\n        return self.m[k]\n`;
  const plan = planCreateInsertion(target, sandbox, "put", PYTHON);
  const built = landCreate(target, plan, "def put(self, k, v):\n        self.m[k] = v");
  assert.ok(built.includes("return self.m[k]\n\n    def put(self, k, v):\n        self.m[k] = v"), `lands under the class at child indent:\n${built}`);
});
