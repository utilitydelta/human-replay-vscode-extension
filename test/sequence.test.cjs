// Unit tests for the diff-replay step sequence (src/disclosure/sequence.ts).
//
// Two things the controller leans on: the steps are in reading order (so Tab
// walks top-to-bottom), and each is correctly classified by surface — a same-line
// edit can ride the native inline-completion `range`, a multi-line one cannot.
// Replaying the ordered steps still rebuilds new byte-exact (ordering changes the
// sequence, not the result).
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".sequence.bundle.cjs");
fs.writeFileSync(
  path.join(__dirname, ".sequence.entry.ts"),
  `export { buildReplaySteps, asInsertion } from "../src/disclosure/sequence";\nexport { replayLive } from "../src/disclosure/replay";\n`,
);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, ".sequence.entry.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown"],
});
const { buildReplaySteps, asInsertion, replayLive } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(path.join(__dirname, ".sequence.entry.ts"), { force: true });
});

// --- corpus: (old, new) with the expected surface of the change -------------
// `nativeable` = the change is a same-line replace/delete that rides the native
// inline surface; false = multi-line (whole-symbol delete, a new-line insert).
const CORPUS = [
  {
    name: "single-line replace (operator change — the demo modification beat)",
    old: `fn must_fence(now: u64) -> bool {\n    for peer in peers {\n        if peer.expiry < now {\n            return true;\n        }\n    }\n    false\n}\n`,
    new: `fn must_fence(now: u64) -> bool {\n    for peer in peers {\n        if peer.expiry <= now {\n            return true;\n        }\n    }\n    false\n}\n`,
    nativeable: true,
  },
  {
    name: "single-line modify-body",
    old: `fn run() {\n    let a = 1;\n    let b = 2;\n}\n`,
    new: `fn run() {\n    let a = 1;\n    let b = 20;\n}\n`,
    nativeable: true,
  },
  {
    // A comment token spans its trailing newline on BOTH sides, so without the
    // shared-newline-tail trim this promotes to a block op and loses the proven
    // single-line surface (F5: strike with no ghost, dead Tab).
    name: "doc-comment reword (comment token carries the trailing newline)",
    old: `/// Simulates the non-leader commit path: queue → sync.\nfn helper() {\n    let a = 1;\n}\n`,
    new: `/// Simulates the immediate non-leader commit path (standalone):\nfn helper() {\n    let a = 1;\n}\n`,
    nativeable: true,
  },
  {
    name: "multi-line delete (whole fn removed)",
    old: `fn keep() {\n    let a = 1;\n}\n\nfn doomed() {\n    let b = 2;\n}\n`,
    new: `fn keep() {\n    let a = 1;\n}\n`,
    nativeable: false,
  },
  {
    name: "new-line insert (appended statement)",
    old: `fn run() {\n    let a = 1;\n}\n`,
    new: `fn run() {\n    let a = 1;\n    let b = 2;\n}\n`,
    nativeable: false,
  },
];

// --- invariants ------------------------------------------------------------

for (const { name, old: oSrc, new: nSrc, nativeable } of CORPUS) {
  test(`${name}: steps are in reading order (non-decreasing start)`, () => {
    const steps = buildReplaySteps(oSrc, nSrc);
    for (let i = 1; i < steps.length; i++) {
      assert.ok(steps[i].start >= steps[i - 1].start, `step ${i} must not precede ${i - 1}`);
    }
  });

  test(`${name}: ordered steps still rebuild new byte-exact`, () => {
    const steps = buildReplaySteps(oSrc, nSrc);
    assert.strictEqual(replayLive(oSrc, steps), nSrc);
  });

  test(`${name}: the change is classified ${nativeable ? "native-able" : "non-native"}`, () => {
    const steps = buildReplaySteps(oSrc, nSrc);
    const changing = steps.filter((s) => s.start !== s.end || s.replacement !== "");
    assert.ok(changing.length > 0, "expected at least one changing step");
    // The single defining change of each fixture must classify as expected.
    assert.ok(
      changing.some((s) => s.singleLine === nativeable),
      `expected a ${nativeable ? "single" : "multi"}-line change step`,
    );
    if (nativeable) assert.ok(changing.every((s) => s.singleLine), "no step should need a non-native surface");
  });
}

// --- asInsertion: a multi-line additive op is a point-insert, not a block swap ---
// The controller serves these as an open-a-line ghost. Each case asserts that
// inserting `text` at the reported side of `oldText` reproduces `replacement` — so
// the ghost is byte-exact ground truth, never a synthesized line.
const INSERTIONS = [
  {
    name: "new argument line (the commit_sync call — 1.1/1.2)",
    oldText: ",\n            ",
    replacement: ",\n            CommitTarget::Immediate,\n            ",
    expect: { atEnd: true, text: "CommitTarget::Immediate,\n            " },
  },
  {
    name: "new signature param line",
    oldText: ",\n    ",
    replacement: ",\n    commit_target: CommitTarget,\n    ",
    expect: { atEnd: true, text: "commit_target: CommitTarget,\n    " },
  },
  {
    name: "pure insert (empty old span — a fresh comment block)",
    oldText: "",
    replacement: "// Deferred.\n            ",
    expect: { atEnd: false, text: "// Deferred.\n            " },
  },
  {
    name: "prepended line (replacement ends with the old span)",
    oldText: "            shard.commit();",
    replacement: "            shard.flush();\n            shard.commit();",
    expect: { atEnd: false, text: "            shard.flush();\n" },
  },
];

for (const { name, oldText, replacement, expect } of INSERTIONS) {
  test(`asInsertion: ${name} — classified as a point-insert`, () => {
    const got = asInsertion(oldText, replacement);
    assert.deepStrictEqual(got, expect);
  });
  test(`asInsertion: ${name} — inserting at the reported side rebuilds the replacement`, () => {
    const { atEnd, text } = asInsertion(oldText, replacement);
    const rebuilt = atEnd ? oldText + text : text + oldText;
    assert.strictEqual(rebuilt, replacement);
  });
}

test("asInsertion: a genuine block rewrite is NOT an insertion (returns null)", () => {
  // The match-arm restructure in commit_sync: neither a prefix nor suffix of the new.
  assert.strictEqual(asInsertion("if !node_status.is_leader() {", "match commit_target {"), null);
  assert.strictEqual(asInsertion("// Non-leader: advance.\n    if x {", "let y = z;\n    if x {".replace("if x {", "if w {")), null);
});
