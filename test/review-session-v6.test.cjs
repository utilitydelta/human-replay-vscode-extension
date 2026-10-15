// Review oracles for session-v6 (deleteVerdict, src/disclosure/resume.ts).
//
// The invariant: a Delete step strikes only an item the sandbox end state does
// not keep, and its `at` is where those strike bytes start in the target. An
// item is known by its spot (container headers + name), so a surviving item
// whose bytes are still on their way to the sandbox's is never struck.
// Tests prefixed HOLE assert CURRENT behaviour the review calls a defect, so a
// green run is the reproduction; flip them when the defect is fixed.
//
// Run: node --test test/review-session-v6.test.cjs

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const bundle = path.join(__dirname, ".review-session-v6.bundle.cjs");
esbuild.buildSync({
  stdin: {
    contents:
      `export { deleteVerdict, extractSymbol } from "./src/disclosure/resume.ts";\n` +
      `export { RUST, TYPESCRIPT, CSHARP, PYTHON, MARKDOWN, CSS, HTML } from "./src/disclosure/language.ts";\n`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const m = require(bundle);
const { deleteVerdict, extractSymbol } = m;
test.after(() => fs.rmSync(bundle, { force: true }));

const LANDED = { landed: true };
const KEPT_BY_SPOT = { landed: true, bySpot: true };
const BASE = fs.readFileSync(path.join(__dirname, "corpus/pick-base.rs"), "utf8");
const SANDBOX = fs.readFileSync(path.join(__dirname, "corpus/pick-sandbox.rs"), "utf8");
const METHOD_TAIL = "            SlotScan::Untested(_) | SlotScan::TailPassed(_) => SlotFault::Outranked,\n";
const IMPL_START = SANDBOX.indexOf("impl SlotScan {");
const IMPL = SANDBOX.slice(IMPL_START, SANDBOX.indexOf("\n}\n", IMPL_START) + 2);
const PARITY = BASE.indexOf("fn parity_slot(");
const BASE_PLUS_METHOD = `${BASE.slice(0, PARITY)}${IMPL}\n\n${BASE.slice(PARITY)}`;

/** Asserts the verdict strikes bytes that start with `head`, and that `at` reads them back. */
function assertStrikes(target, v, head) {
  assert.strictEqual(v.landed, false, "expected a strike, got landed");
  assert.ok(v.strike.startsWith(head), `strike starts ${JSON.stringify(v.strike.slice(0, 40))}, wanted ${head}`);
  assert.strictEqual(target.slice(v.at, v.at + v.strike.length), v.strike, "at does not read the strike back");
}

// --- Loop 1 holes, now oracles ---

test("the free fn gone and SlotScan::fault carrying a line the human kept reads landed", () => {
  assert.ok(SANDBOX.includes(METHOD_TAIL));
  const target = SANDBOX.replace(METHOD_TAIL, METHOD_TAIL + "            // human note\n");
  assert.deepStrictEqual(deleteVerdict(target, SANDBOX, "fault"), KEPT_BY_SPOT);
});

test("the free fn gone and SlotScan::fault at an earlier version (a later modify pending) reads landed", () => {
  const target = SANDBOX.replace("SlotFault::Outranked,\n        }", "SlotFault::OpenCheck,\n        }");
  assert.notStrictEqual(target, SANDBOX);
  assert.deepStrictEqual(deleteVerdict(target, SANDBOX, "fault"), KEPT_BY_SPOT);
});

test("base plus an earlier-version method still strikes the free fn, never the method", () => {
  const target = BASE_PLUS_METHOD.replace("SlotFault::Outranked,\n        }", "SlotFault::OpenCheck,\n        }");
  const v = deleteVerdict(target, SANDBOX, "fault");
  assertStrikes(target, v, "fn fault(check: SlotCheck)");
  assert.strictEqual(v.candidates, 1);
});

test("C#: Delete Foo strikes the constructor, not the class Foo the sandbox keeps", () => {
  const target = "class Foo\n{\n    Foo() { x = 1; }\n    void Bar() { }\n}\n";
  const sandbox = "class Foo\n{\n    void Bar() { }\n}\n";
  const v = deleteVerdict(target, sandbox, "Foo", m.CSHARP);
  assertStrikes(target, v, "Foo() { x = 1; }");
  assert.strictEqual(v.strike, "Foo() { x = 1; }");
});

test("Rust: mod fault { fn fault } with the inner fn deleted strikes the inner fn, not the mod", () => {
  const target = "mod fault {\n    fn fault() {}\n    fn keep() {}\n}\n";
  const sandbox = "mod fault {\n    fn keep() {}\n}\n";
  const v = deleteVerdict(target, sandbox, "fault");
  assertStrikes(target, v, "fn fault() {}");
  assert.strictEqual(v.strike, "fn fault() {}");
});

test("fenced Before: the free fn's bytes sit exactly once in base plus the method, so the park is the free fn", () => {
  const fence = extractSymbol(BASE, "fault");
  const at = BASE_PLUS_METHOD.indexOf(fence);
  assert.ok(at >= 0 && BASE_PLUS_METHOD.indexOf(fence, at + 1) < 0);
  assert.ok(BASE_PLUS_METHOD.slice(at).startsWith("fn fault(check: SlotCheck)"));
});

// --- Loop 2 re-review ---

test("Rust: two `impl SlotScan` blocks share a spot; the method moved between them is not a candidate", () => {
  const target = "struct S;\nimpl S {\n    fn fault(&self) {}\n}\nimpl S {\n    fn other(&self) {}\n}\n";
  const sandbox = "struct S;\nimpl S {}\nimpl S {\n    fn other(&self) {}\n    fn fault(&self) {}\n}\n";
  assert.deepStrictEqual(deleteVerdict(target, sandbox, "fault"), LANDED);
});

test("CSS: a rule inside @media is its own spot; deleting the top-level .a strikes it, not the media one", () => {
  const target = ".a { color: red; }\n@media print {\n  .a { color: blue; }\n}\n";
  const sandbox = "@media print {\n  .a { color: green; }\n}\n";
  assertStrikes(target, deleteVerdict(target, sandbox, ".a", m.CSS), ".a { color: red; }");
});

test("Markdown: sections have no container spot, so a kept `### Fixed` mid-edit makes the delete a warned coin flip", () => {
  const target = "# Log\n\n## 2.0\n\n### Fixed\n\n- a\n\n## 1.0\n\n### Fixed\n\n- b\n";
  const sandbox = "# Log\n\n## 1.0\n\n### Fixed\n\n- b, edited\n";
  const v = deleteVerdict(target, sandbox, "Fixed", m.MARKDOWN);
  assert.strictEqual(v.landed, false);
  assert.strictEqual(v.candidates, 2, "both Fixed sections are candidates; runner warns and strikes the first");
});

test("TS: a class gaining `export` keeps its spot (header reads from the class node)", () => {
  const target = "export class Scan {\n  fault() { return 1; }\n}\n";
  const sandbox = "class Scan {\n  fault() { return 2; }\n}\n";
  assert.deepStrictEqual(deleteVerdict(target, sandbox, "fault", m.TYPESCRIPT), KEPT_BY_SPOT);
});

test("header drift: the human wrote `impl<'a> SlotScan<'a>` while the sandbox has `impl SlotScan`: the method is kept", () => {
  const target = SANDBOX.replace("impl SlotScan {", "impl<'a> SlotScan<'a> {");
  assert.deepStrictEqual(deleteVerdict(target, SANDBOX, "fault"), LANDED);
});

test("header drift from a pending later modify of the container (TS class gains `extends`): the method is kept", () => {
  const target = "class Scan {\n  fault() { return 1; }\n}\n";
  const sandbox = "class Scan extends Base {\n  fault() { return 1; }\n}\n";
  assert.deepStrictEqual(deleteVerdict(target, sandbox, "fault", m.TYPESCRIPT), LANDED);
});

test("header drift from a pending C# class modify (gains a base type): the method is kept", () => {
  const target = "class Foo\n{\n    void Run() { }\n}\n";
  const sandbox = "class Foo : IBar\n{\n    void Run() { }\n}\n";
  assert.deepStrictEqual(deleteVerdict(target, sandbox, "Run", m.CSHARP), LANDED);
});

test("a trait impl is its own container: deleting the inherent fault never reads landed off the trait impl's", () => {
  const target = "impl S {\n    fn fault(&self) {}\n}\nimpl Tr for S {\n    fn fault(&self) {}\n}\n";
  const sandbox = "impl S {}\nimpl Tr for S {\n    fn fault(&self) { x(); }\n}\n";
  assertStrikes(target, deleteVerdict(target, sandbox, "fault"), "fn fault(&self) {}");
});

// --- Loop 3 re-review: containerIdentity edges ---

test("HOLE: `impl Foo<u8>` and `impl Foo<u16>` are distinct legal inherent impls but share one identity: a delete reads landed off the other's `new`", () => {
  const target = "impl Foo<u8> {\n    fn new() -> Self { a() }\n}\n";
  const sandbox = "impl Foo<u8> {}\nimpl Foo<u16> {\n    fn new() -> Self { b() }\n}\n";
  assert.deepStrictEqual(deleteVerdict(target, sandbox, "new"), KEPT_BY_SPOT);
});

test("HOLE: `impl From<u8> for X` and `impl From<u16> for X` share one identity", () => {
  const target = "impl From<u8> for X {\n    fn from(v: u8) -> Self { a(v) }\n}\n";
  const sandbox = "impl From<u16> for X {\n    fn from(v: u16) -> Self { b(v) }\n}\n";
  assert.deepStrictEqual(deleteVerdict(target, sandbox, "from"), KEPT_BY_SPOT);
});

test("HOLE: lifetime drift inside a reference type is not stripped (`&'a Foo` vs `&'b Foo`): the kept method is struck", () => {
  const target = "impl<'a> Tr for &'a Foo {\n    fn fault(&self) {}\n}\n";
  const sandbox = "impl<'b> Tr for &'b Foo {\n    fn fault(&self) {}\n}\n";
  assertStrikes(target, deleteVerdict(target, sandbox, "fault"), "fn fault(&self) {}");
});

test("HOLE: qualifying the type (`impl SlotScan` to `impl scan::SlotScan`) is drift: the kept method is struck", () => {
  const target = SANDBOX.replace("impl SlotScan {", "impl scan::SlotScan {");
  assertStrikes(target, deleteVerdict(target, SANDBOX, "fault"), "fn fault(self) -> SlotFault");
});

test("generic trait + generic type strip to base names: `impl<T> Tr<T> for Vec<T>` matches `impl Tr<u8> for Vec<u8>`", () => {
  const target = "impl<T> Tr<T> for Vec<T> {\n    fn fault(&self) {}\n}\n";
  const sandbox = "impl Tr<u8> for Vec<u8> {\n    fn fault(&self) { y(); }\n}\n";
  assert.deepStrictEqual(deleteVerdict(target, sandbox, "fault"), KEPT_BY_SPOT);
});

test("HOLE: TS abstract class is no container, so its method shares the free function's spot", () => {
  const target = "abstract class Scan {\n  fault(): number { return 1; }\n}\n";
  const sandbox = "function fault(): number { return 2; }\n";
  assert.deepStrictEqual(deleteVerdict(target, sandbox, "fault", m.TYPESCRIPT), KEPT_BY_SPOT);
});

// --- The validator FAILs a delete-then-recreate at the same spot ---

const { spawnSync } = require("child_process");
const os = require("os");

function validate(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-v6-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return spawnSync(process.execPath, [path.join(root, "scripts/validate-guide.js"), path.join(dir, "guide.md"), path.join(dir, "t"), path.join(dir, "s")], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const guide = (steps) =>
  `# Replay: v6\n\n## Overview\n\n**Built:** A move.\n\n## System Invariants\n\n- **Order:** fault after other.\n\n## Phase 1: Move\n\n${steps}`;
const step = (id, action, extra = "") =>
  `### Step ${id}: fault\n\n**File:** \`src/a.rs\`\n**Action:** ${action}\n**Symbol:** \`fault\`\n**Invariants:** Order\n\n**Why:** It moves.\n${extra}\n`;

test("validator: a delete then a create of the same name at the same spot FAILs with the fold advice", () => {
  const r = validate({
    "guide.md": guide(step("1.1", "Delete") + step("1.2", "Create")),
    "t/src/a.rs": "fn fault() -> u8 {\n    1\n}\n\nfn other() {}\n",
    "s/src/a.rs": "fn other() {}\n\nfn fault() -> u8 {\n    2\n}\n",
  });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL\s+1\.1\s+delete\s+fault .*fold this delete and the later step into one Modify/);
});

test("validator: a plain delete PASSes and strikes", () => {
  const r = validate({
    "guide.md": guide(step("1.1", "Delete")),
    "t/src/a.rs": "fn fault() -> u8 {\n    1\n}\n\nfn other() {}\n",
    "s/src/a.rs": "fn other() {}\n",
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok\s+1\.1\s+delete\s+fault .*strikes the existing symbol/);
});

test("HOLE: validator PASSes a fenced-Before delete whose bytes are not in the target; the runner blocks it", () => {
  const r = validate({
    "guide.md": guide(step("1.1", "Delete", "\n**Before:**\n```rust\nfn fault() -> u8 {\n    7\n}\n```\n")),
    "t/src/a.rs": "fn fault() -> u8 {\n    1\n}\n\nfn other() {}\n",
    "s/src/a.rs": "fn other() {}\n",
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok\s+1\.1\s+delete/);
});

// --- Sound: with no sandbox every item is a candidate; the first is the old pick and at reads it back ---

const CASES = [
  ["rust nested + doc", m.RUST, "fault", "/// a\nfn fault() {}\n\nimpl A {\n    /// b\n    #[inline]\n    fn fault(&self) {}\n}\n", 2],
  ["rust CRLF + attribute", m.RUST, "fault", "#[cfg(test)]\r\nfn fault() {}\r\n\r\nimpl A {\r\n    /// b\r\n    fn fault(&self) {}\r\n}\r\n", 2],
  ["rust nested same name", m.RUST, "fault", "mod fault {\n    fn fault() {}\n}\n", 2],
  ["ts export lift", m.TYPESCRIPT, "fault", "export function fault() {}\n\nclass A {\n  fault() {}\n}\nexport const fault2 = 1;\n", 2],
  ["ts export const lift", m.TYPESCRIPT, "k", "export const k = 1;\nfunction f() { const k = 2; }\n", 2],
  ["python decorated", m.PYTHON, "fault", "@dec\ndef fault():\n    pass\n\nclass A:\n    @staticmethod\n    def fault():\n        pass\n", 2],
  ["markdown nested sections", m.MARKDOWN, "Fixed", "# Log\n\n## 2.0\n\n### Fixed\n\n- a\n\n## 1.0\n\n### Fixed\n\n- b\n", 2],
  ["css rules", m.CSS, ".a", ".a { color: red; }\n@media print {\n  .a { color: blue; }\n}\n", 2],
  ["csharp ctor in class", m.CSHARP, "Foo", "class Foo\n{\n    // one\n    Foo() { }\n}\n", 2],
  ["csharp overloads", m.CSHARP, "Run", "class A\n{\n    // one\n    void Run() { }\n    void Run(int x) { }\n}\n", 2],
];

for (const [why, spec, name, text, count] of CASES) {
  test(`sound (${why}): no sandbox strikes extractSymbol's pick, at reads it back, target===sandbox is landed`, () => {
    const v = deleteVerdict(text, undefined, name, spec);
    assert.strictEqual(v.landed, false);
    assert.strictEqual(v.candidates, count);
    assert.strictEqual(text.slice(v.at, v.at + v.strike.length), v.strike);
    assert.strictEqual(v.strike, extractSymbol(text, name, spec));
    assert.deepStrictEqual(deleteVerdict(text, text, name, spec), LANDED);
  });
}

test("sound: the incident corpus, base plus method strikes and parks on the free fn; sandbox reads landed", () => {
  assertStrikes(BASE_PLUS_METHOD, deleteVerdict(BASE_PLUS_METHOD, SANDBOX, "fault"), "fn fault(check: SlotCheck)");
  assert.deepStrictEqual(deleteVerdict(SANDBOX, SANDBOX, "fault"), LANDED);
});
