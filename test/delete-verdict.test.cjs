// Unit tests for the delete verdict (deleteVerdict, src/disclosure/resume.ts).
//
// The invariant: a Delete step removes only items the sandbox end state no longer
// holds at their spot. A spot is the headers of an item's containers plus its
// name. At each spot, byte-equal target/sandbox items pair off, then the sandbox's
// remaining items there keep as many target items, whatever their bytes (a kept
// item may still await a modify or hold a line the human typed). Leftovers beyond
// the kept slots are all candidates. No candidate means the delete has landed.
// Otherwise the strike is the first candidate, never an item the end state still
// needs, and `at` is its offset in the target, so the cursor parks on the
// candidate and not on the first item with the name. A landed verdict carries
// `bySpot: true` (only then) when a differing target item was kept for its spot.
// Containers are known by identity: kind and name, or for a Rust impl its trait
// and type with generics stripped. The field incident (pick.rs step 2.21)
// struck the method `SlotScan::fault` because it shared a bare name with the
// deleted free fn.
//
// Run: node --test test/delete-verdict.test.cjs (also part of npm test)

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const bundle = path.join(__dirname, ".delete-verdict.bundle.cjs");
esbuild.buildSync({
  stdin: {
    contents: `export { deleteVerdict } from "./src/disclosure/resume.ts";\nexport { RUST, TYPESCRIPT, CSHARP } from "./src/disclosure/language.ts";\n`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { deleteVerdict, RUST, TYPESCRIPT, CSHARP } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

const LANDED = { landed: true };
// Landed, but some target item that differs from the sandbox was kept only for its spot.
const BY_SPOT = { landed: true, bySpot: true };
const strike = (bytes, candidates) => ({ landed: false, strike: bytes, candidates });

/** Asserts a verdict against an expected row. For a strike, `at` must address the
 *  strike's bytes in the target, and must be where those bytes occur (derived by
 *  string search, never a hardcoded offset). Returns the verdict. */
function assertVerdict(target, got, expected) {
  if (expected.landed) {
    assert.deepStrictEqual(got, expected);
    return got;
  }
  const { at, ...rest } = got;
  assert.deepStrictEqual(rest, expected);
  assert.strictEqual(typeof at, "number", "a strike carries its offset");
  assert.strictEqual(target.slice(at, at + got.strike.length), got.strike, "at addresses the strike's bytes in the target");
  const first = target.indexOf(expected.strike);
  if (target.indexOf(expected.strike, first + 1) < 0) {
    assert.strictEqual(at, first, "at is the offset of the only occurrence of the strike bytes");
  }
  return got;
}

// --- Recorded field incident: celeriant pick.rs, step 2.21 `Delete fault` ---

const BASE = fs.readFileSync(path.join(__dirname, "corpus/pick-base.rs"), "utf8");
const SANDBOX = fs.readFileSync(path.join(__dirname, "corpus/pick-sandbox.rs"), "utf8");

/** The exact bytes of the block starting at `head`, through its closing `}` at column 0. */
function blockFrom(text, head) {
  const start = text.indexOf(head);
  assert.ok(start >= 0, `corpus lost its anchor: ${head}`);
  const end = text.indexOf("\n}\n", start);
  assert.ok(end > start, `corpus block has no column-0 close: ${head}`);
  return text.slice(start, end + 2);
}

const FREE_FAULT = blockFrom(BASE, "fn fault(check: SlotCheck)");
const IMPL_SLOT_SCAN = blockFrom(SANDBOX, "impl SlotScan {");
const PARITY_SLOT = BASE.indexOf("fn parity_slot(");
// The base with the sandbox's method added before step 2.21 runs: both faults
// present, the method first in document order, so "first item named fault" is the
// method and only the candidate rule lands on the free fn.
const BASE_PLUS_METHOD = `${BASE.slice(0, PARITY_SLOT)}${IMPL_SLOT_SCAN}\n\n${BASE.slice(PARITY_SLOT)}`;
const METHOD_START = BASE_PLUS_METHOD.indexOf(IMPL_SLOT_SCAN);
const METHOD_END = METHOD_START + IMPL_SLOT_SCAN.length;

/** `text` with exactly one occurrence of `from` replaced; fails loud if the anchor moved. */
function edit(text, from, to) {
  const i = text.indexOf(from);
  assert.ok(i >= 0 && text.indexOf(from, i + 1) < 0, `corpus anchor not unique: ${from}`);
  return text.slice(0, i) + to + text.slice(i + from.length);
}

const METHOD_HEAD = "    fn fault(self) -> SlotFault {\n";
// The end state with a line the human kept inside the method.
const SANDBOX_LINE_ADDED = edit(SANDBOX, METHOD_HEAD, `${METHOD_HEAD}        let _ = self.header_seq();\n`);
// The end state with the method's bytes behind (a later modify still pending).
const ARM_OLD = "SlotScan::TailFailed(_) => SlotFault::TailCheck,";
const ARM_NEW = "SlotScan::TailFailed(_) => SlotFault::OpenCheck,";
const SANDBOX_ARM_CHANGED = edit(SANDBOX, ARM_OLD, ARM_NEW);
// The base plus a method that does not yet hold its end-state bytes.
const BASE_PLUS_DIFFERENT_METHOD = edit(BASE_PLUS_METHOD, ARM_OLD, ARM_NEW);
// The end state with the impl header gaining generics: the same container.
const SANDBOX_GENERIC_IMPL = edit(SANDBOX, "impl SlotScan {", "impl<'a> SlotScan<'a> {");
// The end state plus a trait impl holding a byte-identical `fault`: another container.
const METHOD_BYTES = SANDBOX.slice(SANDBOX.indexOf("fn fault(self)"), SANDBOX.indexOf("\n    }\n", SANDBOX.indexOf("fn fault(self)")) + 6);
const TRAIT_IMPL = `impl fmt::Display for SlotScan {\n    ${METHOD_BYTES}\n}\n`;
const SANDBOX_PLUS_TRAIT_IMPL = `${SANDBOX}\n${TRAIT_IMPL}`;

test("harness: the corpus shapes the incident needs are present", () => {
  assert.ok(FREE_FAULT.endsWith("}") && FREE_FAULT.includes("SlotCheck::TailFailed"));
  assert.ok(IMPL_SLOT_SCAN.includes("fn fault(self) -> SlotFault"));
  assert.ok(!SANDBOX.includes("fn fault(check: SlotCheck)"));
  assert.ok(BASE_PLUS_METHOD.includes(FREE_FAULT) && BASE_PLUS_METHOD.includes(IMPL_SLOT_SCAN));
  assert.ok(METHOD_END < BASE_PLUS_METHOD.indexOf(FREE_FAULT), "the method precedes the free fn");
});

// [why, target, expected]
const INCIDENT = [
  ["the sandbox end state reads landed, the surviving method is not a candidate", SANDBOX, LANDED],
  ["the base strikes the free fn the sandbox lost", BASE, strike(FREE_FAULT, 1)],
  ["base plus the method strikes the free fn, never the method the end state needs", BASE_PLUS_METHOD, strike(FREE_FAULT, 1)],
  ["a line kept inside the method leaves it at its spot, landed by spot", SANDBOX_LINE_ADDED, BY_SPOT],
  ["a method behind on a match arm is still kept at its spot, landed by spot", SANDBOX_ARM_CHANGED, BY_SPOT],
  ["impl<'a> SlotScan<'a> is the same container as impl SlotScan, the byte-equal method pairs off", SANDBOX_GENERIC_IMPL, LANDED],
  ["base plus a byte-different method strikes the free fn, the method's spot keeps it", BASE_PLUS_DIFFERENT_METHOD, strike(FREE_FAULT, 1)],
];

for (const [why, target, expected] of INCIDENT) {
  test(`pick.rs Delete fault: ${why}`, () => {
    assertVerdict(target, deleteVerdict(target, SANDBOX, "fault"), expected);
  });
}

test("pick.rs Delete fault: a trait impl is another container, its byte-identical fault is struck, not the inherent one", () => {
  assert.ok(METHOD_BYTES.startsWith("fn fault(self)") && METHOD_BYTES.endsWith("    }"), "harness cut the whole method");
  const got = assertVerdict(SANDBOX_PLUS_TRAIT_IMPL, deleteVerdict(SANDBOX_PLUS_TRAIT_IMPL, SANDBOX, "fault"), strike(METHOD_BYTES, 1));
  assert.ok(got.at > SANDBOX_PLUS_TRAIT_IMPL.indexOf(TRAIT_IMPL), `at ${got.at} parks in the inherent impl, not the trait impl`);
});

test("pick.rs Delete fault: base plus the method parks on the free fn, not inside the method", () => {
  const got = deleteVerdict(BASE_PLUS_METHOD, SANDBOX, "fault");
  assert.strictEqual(got.landed, false);
  assert.strictEqual(got.at, BASE_PLUS_METHOD.indexOf(FREE_FAULT));
  assert.ok(got.at >= METHOD_END, `at ${got.at} falls inside the impl SlotScan block [${METHOD_START}, ${METHOD_END})`);
});

// --- Synthetic Rust rows ---

const DOC_A = "/// Ranks by sequence.\n";
const DOC_B = "/// Ranks by age.\n";
const F_ONE = "fn f() -> u8 {\n        1\n    }";
const F_TWO = "fn f() -> u8 {\n        2\n    }";
const impl = (name, item, doc = "") => `impl ${name} {\n    ${doc ? doc + "    " : ""}${item}\n}\n`;
const file = (...parts) => `use std::fmt;\n\n${parts.join("\n")}`;

// [why, target, sandbox, expected]
const RUST_ROWS = [
  ["a symbol absent from the target has landed", file("fn g() {}\n"), file(impl("A", F_ONE)), LANDED],
  ["two identical items at one spot against one sandbox item there leave one candidate", file(`impl A {\n    ${F_ONE}\n\n    ${F_ONE}\n}\n`), file(impl("A", F_ONE)), strike(F_ONE, 1)],
  ["an identical item at a spot the sandbox lacks is a candidate, bytes elsewhere do not keep it", file(impl("A", F_ONE), impl("B", F_ONE)), file(impl("A", F_ONE)), strike(F_ONE, 1)],
  ["two root items against one sandbox root item, none byte-equal, are both candidates", file("fn f() -> u8 {\n    1\n}\n", "fn f() -> u8 {\n    2\n}\n"), file("fn f() -> u8 {\n    3\n}\n"), strike("fn f() -> u8 {\n    1\n}", 2)],
  ["two distinct items the sandbox lacks are both candidates, the first in document order is struck", file(impl("A", F_TWO), impl("B", F_ONE)), file("fn g() {}\n"), strike(F_TWO, 2)],
  ["an undefined sandbox holds nothing, every target item is a candidate", file(impl("A", F_ONE), impl("B", F_TWO)), undefined, strike(F_ONE, 2)],
  ["an undefined target has no items, the delete has landed", undefined, file(impl("A", F_ONE)), LANDED],
  ["an undefined target and sandbox has landed", undefined, undefined, LANDED],
  ["an item whose doc comment differs is kept at its spot, rewording it is a modify's job, landed by spot", file(impl("A", F_ONE, DOC_B)), file(impl("A", F_ONE, DOC_A)), BY_SPOT],
  ["a strike carries the candidate's doc comment, bytes include trivia", file(impl("A", F_ONE), impl("B", F_TWO, DOC_B)), file(impl("A", F_ONE)), strike(`${DOC_B}    ${F_TWO}`, 1)],
  ["an item matching the sandbox with its doc comment is not a candidate", file(impl("A", F_ONE, DOC_A)), file(impl("A", F_ONE, DOC_A)), LANDED],
];

for (const [why, target, sandbox, expected] of RUST_ROWS) {
  test(`deleteVerdict (Rust): ${why}`, () => {
    const got = assertVerdict(target, deleteVerdict(target, sandbox, "f"), expected);
    assert.deepStrictEqual(deleteVerdict(target, sandbox, "f", RUST), got, "explicit RUST spec agrees with the default");
  });
}

// --- TypeScript: the same incident shape, a class method beside a free function ---

const TS_FREE = "function fault(check: Check): Fault {\n  return check.passed ? Fault.Outranked : Fault.Open;\n}";
const TS_CLASS = "class Scan {\n  fault(): Fault {\n    return this.err ?? Fault.Outranked;\n  }\n}";
const TS_SANDBOX = `import { Fault } from "./fault";\n\n${TS_CLASS}\n`;
const TS_BASE_PLUS_METHOD = `import { Fault } from "./fault";\n\n${TS_FREE}\n\n${TS_CLASS}\n`;

test("deleteVerdict (TypeScript): the sandbox end state reads landed, the class method is not a candidate", () => {
  assertVerdict(TS_SANDBOX, deleteVerdict(TS_SANDBOX, TS_SANDBOX, "fault", TYPESCRIPT), LANDED);
});

test("deleteVerdict (TypeScript): the free function is struck, never the class method of the same name", () => {
  assertVerdict(TS_BASE_PLUS_METHOD, deleteVerdict(TS_BASE_PLUS_METHOD, TS_SANDBOX, "fault", TYPESCRIPT), strike(TS_FREE, 1));
});

test("deleteVerdict (TypeScript): a class gaining extends keeps its identity, the identical method pairs off", () => {
  const target = TS_SANDBOX.replace("class Scan {", "class Scan extends Base {");
  assert.notStrictEqual(target, TS_SANDBOX);
  assertVerdict(target, deleteVerdict(target, TS_SANDBOX, "fault", TYPESCRIPT), LANDED);
});

// --- C#: a constructor is its own item inside the class that shares its name ---

const CS_CTOR = "public Foo() {}";
const CS_TARGET = `class Foo\n{\n    ${CS_CTOR}\n\n    void M() {}\n}\n`;
const CS_SANDBOX = "class Foo\n{\n    void M() {}\n}\n";

test("deleteVerdict (C#): Delete Foo strikes exactly the constructor, the class keeps its spot", () => {
  assertVerdict(CS_TARGET, deleteVerdict(CS_TARGET, CS_SANDBOX, "Foo", CSHARP), strike(CS_CTOR, 1));
});

test("deleteVerdict (C#): the sandbox end state reads landed for Delete Foo", () => {
  assertVerdict(CS_SANDBOX, deleteVerdict(CS_SANDBOX, CS_SANDBOX, "Foo", CSHARP), LANDED);
});
