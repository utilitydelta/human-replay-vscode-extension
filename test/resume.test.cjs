// Unit tests for resume derivation (src/disclosure/resume.ts).
//
// The invariant: a step is marked already-landed ONLY from real bytes agreeing on
// both sides — target symbol byte-identical to sandbox symbol (create/modify), or
// symbol gone from the target (delete). Missing evidence never marks a step done,
// so resume can skip real progress but can never fake it (invariant 1).
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".resume.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/resume.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust"],
});
const { extractSymbol, stepAlreadyLanded } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

const FN = `/// Commits the batch.\nfn commit_sync(x: u64) -> u64 {\n    x + 1\n}`;
const FN_EDITED = `/// Commits the batch.\nfn commit_sync(x: u64) -> u64 {\n    x + 2\n}`;
const OTHER = `fn other() {}`;
const FILE = (body) => `${OTHER}\n\n${body}\n`;

test("extractSymbol: returns the item's exact bytes, doc comment included", () => {
  const got = extractSymbol(FILE(FN), "commit_sync");
  assert.strictEqual(got, FN);
});

test("extractSymbol: absent symbol resolves to undefined, not a guess", () => {
  assert.strictEqual(extractSymbol(FILE(FN), "no_such_fn"), undefined);
});

// [action, target text, sandbox text, expected, why]
const CASES = [
  ["modify", FILE(FN), FILE(FN), true, "byte-identical symbol was already landed"],
  ["modify", FILE(FN), FILE(FN_EDITED), false, "a differing symbol still has delta to replay"],
  ["modify", FILE(OTHER), FILE(FN_EDITED), false, "symbol missing from target is unresolved, not landed"],
  ["modify", FILE(FN), FILE(OTHER), false, "symbol missing from sandbox is no evidence — never landed"],
  ["create", FILE(FN), FILE(FN), true, "created symbol already present and identical"],
  ["create", FILE(OTHER), FILE(FN), false, "fresh create has nothing in the target yet"],
  ["create", FILE(FN_EDITED), FILE(FN), false, "partially-built create resumes, it is not done"],
  ["delete", FILE(OTHER), FILE(OTHER), true, "deleted symbol already gone from the target"],
  ["delete", FILE(FN), FILE(OTHER), false, "symbol still in the target — the delete has not run"],
];

for (const [action, target, sandbox, expected, why] of CASES) {
  test(`stepAlreadyLanded(${action}): ${why}`, () => {
    const t = extractSymbol(target, "commit_sync");
    const s = extractSymbol(sandbox, "commit_sync");
    assert.strictEqual(stepAlreadyLanded(action, t, s), expected);
  });
}

// create-file compares WHOLE FILES (the caller passes file contents, not symbols).
const FILE_A = "use crate::*;\n\n#[test]\nfn chaos() { run(); }\n";
const FILE_B = "use crate::*;\n\n#[test]\nfn chaos() { run_twice(); }\n";
const FILE_CASES = [
  ["create-file", FILE_A, FILE_A, true, "target file byte-equals the sandbox file"],
  ["create-file", FILE_B, FILE_A, false, "existing file differs — conflict, not landed"],
  ["create-file", undefined, FILE_A, false, "file not in the target yet"],
  ["create-file", FILE_A, undefined, false, "sandbox file unreadable is no evidence"],
];
for (const [action, target, sandbox, expected, why] of FILE_CASES) {
  test(`stepAlreadyLanded(${action}): ${why}`, () => {
    assert.strictEqual(stepAlreadyLanded(action, target, sandbox), expected);
  });
}
