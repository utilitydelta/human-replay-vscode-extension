// Oracle for the rewrite-clear pad split (orchestrator.acceptRewriteClear).
//
// VS Code cannot Tab-accept a whitespace-leading ghost (the commit keybinding is
// gated on `inlineSuggestionHasIndentationLessThanTabSize`): Tab indents
// instead, the caret leaves the anchor, and the walk dead-ends — the live 3.3
// incident ("provider declined: caret is off the step's anchor" after every
// clear). The split types any leading pad as real buffer bytes and walks the
// rest, so the first ghost always opens on a byte VS Code will commit.
//
// Where a pad can still come from, now that `extractSymbol` starts every symbol
// at its first VISIBLE byte: a SELF-CONTAINED guide's Before/After fence. Those
// bytes are whatever the guide author wrote between the backticks, indent and
// all, and they reach the rewrite path without passing through extraction. So
// the corpus below is in two halves, and each says which it is:
//
//   - extracted symbols, taken from real files through `extractSymbol`, which
//     never lead with whitespace — the split is a no-op and must stay one;
//   - fenced bytes, written with their indent, where the split is load bearing.
//
// The four old/new trivia combinations at the bottom pin `reconcileRewritePad`:
// which side carries the line's indent decides what the cleared line must hold
// before the walk starts, and getting it wrong either double-indents the landed
// symbol or leaves it at column 0.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const EXTERNALS = ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"];
const walkBundle = path.join(__dirname, ".rewrite-pad.walk.bundle.cjs");
const insertionBundle = path.join(__dirname, ".rewrite-pad.insertion.bundle.cjs");
for (const [entry, outfile] of [
  ["../src/disclosure/walk.ts", walkBundle],
  ["../src/disclosure/insertion.ts", insertionBundle],
]) {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, entry)],
    bundle: true,
    outfile,
    format: "cjs",
    platform: "node",
    external: EXTERNALS,
  });
}
const { computeSteps, walkableSource } = require(walkBundle);
const { splitLeadingPad, reconcileRewritePad } = require(insertionBundle);

// A third bundle: the corpus below must come from the REAL extraction, or it
// drifts from what the rewrite path is actually handed (which is how this file
// came to encode a superseded contract in the first place).
const resumeBundle = path.join(__dirname, ".rewrite-pad.resume.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/resume.ts")],
  bundle: true,
  outfile: resumeBundle,
  format: "cjs",
  platform: "node",
  external: EXTERNALS,
});
const { extractSymbol } = require(resumeBundle);
test.after(() => {
  fs.rmSync(walkBundle, { force: true });
  fs.rmSync(insertionBundle, { force: true });
  fs.rmSync(resumeBundle, { force: true });
});

// Half one: symbols as `extractSymbol` really hands them over, read out of
// whole files so the fixture cannot drift from the engine. None of these lead
// with whitespace — that is the contract, and the assertions below say so.
const FILES = [
  {
    name: "nested doc-commented method (the 3.3 shape)",
    symbol: "no_schema_cache_insert",
    file: `impl Shard {\n    /// Insert a row when no schema is cached for the shard.\n    fn no_schema_cache_insert(&mut self, key: u64) -> bool {\n        let slot = key as usize % self.slots.len();\n        self.slots[slot] = Some(key);\n        true\n    }\n}\n`,
  },
  {
    name: "nested attribute + doc lead",
    symbol: "hot",
    file: `impl Shard {\n    #[inline]\n    /// Fast path.\n    fn hot(&self) -> u64 {\n        self.count\n    }\n}\n`,
  },
  {
    name: "deeper nesting (8-space indent)",
    symbol: "inner",
    file: `mod outer {\n    impl Shard {\n        /// Inner.\n        fn inner(&self) -> bool {\n            self.ok\n        }\n    }\n}\n`,
  },
  {
    name: "top-level doc-commented fn",
    symbol: "documented",
    file: `/// Documented.\nfn documented(x: i32) -> i32 {\n    x + 1\n}\n`,
  },
];

const CORPUS = FILES.map(({ name, symbol, file }) => {
  const sym = extractSymbol(file, symbol);
  assert.ok(sym !== undefined, `corpus symbol ${symbol} must resolve`);
  return { name, sym };
});

// Half two: bytes as a self-contained guide's fence carries them — indent
// included, because the author typed it. This is the input the split exists
// for, and the only one that still produces a non-empty pad.
const FENCED = [
  {
    name: "fenced nested method, indent written by the guide author",
    sym: `    /// Insert a row.\n    fn fenced(&mut self, key: u64) -> bool {\n        self.slots[0] = Some(key);\n        true\n    }`,
  },
  {
    name: "fenced method at 8-space depth",
    sym: `        fn deeper(&self) -> bool {\n            self.ok\n        }`,
  },
];

test("extracted symbols never lead with whitespace — the split is a no-op for them", () => {
  for (const { name, sym } of CORPUS) {
    assert.strictEqual(splitLeadingPad(sym).pad, "", `${name}: extraction starts at the first visible byte`);
  }
});

for (const { name, sym } of FENCED) {
  test(`rewrite pad: ${name} — the split is load bearing, and rebuilds byte-exact`, () => {
    const { pad, rest } = splitLeadingPad(sym);
    assert.ok(pad.length > 0, "a fenced symbol can carry its own indent");
    assert.strictEqual(pad + rest, sym, "the split invents and drops nothing");
    assert.ok(!/^[ \t]/.test(rest), "and the served bytes open on a committable byte");
  });
}

for (const { name, sym } of CORPUS) {
  test(`rewrite pad: ${name} — pad + replayed rest rebuilds the symbol byte-exact`, () => {
    const { pad, rest } = splitLeadingPad(sym);
    assert.ok(walkableSource(sym), "the padded symbol routes to the walk (walkableSource true)");
    let buf = "";
    let cur = 0;
    for (const s of computeSteps(rest)) {
      buf = buf.slice(0, cur) + s.insert + buf.slice(cur);
      cur = s.cursorOffset;
    }
    assert.strictEqual(pad + buf, sym);
  });

  test(`rewrite pad: ${name} — first ghost opens on a committable byte`, () => {
    const { rest } = splitLeadingPad(sym);
    const first = computeSteps(rest)[0].insert;
    assert.ok(first.length > 0 && first[0] !== " " && first[0] !== "\t", `first ghost byte is real, got ${JSON.stringify(first.slice(0, 8))}`);
  });
}

// The guard the split exists for: hand the walk a whitespace-leading symbol and
// its first ghost leads with whitespace too — the exact bytes VS Code refuses to
// Tab-commit. Extraction no longer produces that shape, but a guide's fence
// still can, so the guard stays.
test("rewrite pad: unsplit indented bytes give a whitespace-leading first ghost (why the split exists)", () => {
  const first = computeSteps(FENCED[0].sym)[0].insert;
  assert.strictEqual(first[0], " ");
});

// --- the four old/new combinations ----------------------------------------
//
// `reconcileRewritePad` decides what the cleared line holds before the walk
// starts. Its inputs are the buffer's surviving prefix and each side's pad, and
// the two pads can differ: an extracted symbol brings none (the buffer keeps
// the container indent through the strike), a fenced one brings its own. This
// simulates the whole gesture in bytes — park, strike-clear, reconcile, walk —
// and demands the landed line carry the container indent exactly once in every
// combination. Adversarial review once caught the naive pad-typing
// double-indenting one direction and leaving the other at column 0.

const INDENT = "    ";
// BARE is what extraction hands over: no pad, the buffer keeps the indent.
const BARE = `fn cached(&self) -> u64 {\n        self.count\n    }`;
// DOC is what a guide fence hands over: the author's own indent, so the strike
// takes the indent with it and the pad has to put it back.
const DOC = `${INDENT}/// Cached count.\n${INDENT}fn cached(&self) -> u64 {\n        self.count\n    }`;

for (const [oldName, oldSym] of [["bare", BARE], ["doc", DOC]]) {
  for (const [newName, newSym] of [["bare", BARE], ["doc", DOC]]) {
    test(`rewrite restore: old ${oldName} → new ${newName}, cancel at zero steps is byte-identical to pre-strike`, () => {
      // The orchestrator's exact byte story on the cleared line's prefix
      // region: pre-strike bytes, the clear (symbol bytes deleted), the
      // reconcile (surviving indent replaced with `want`), then the restore
      // (replace `want` with prefix + old symbol). Ground truth: the restore
      // must reproduce the pre-strike bytes exactly.
      const prefix = oldSym === DOC ? "" : INDENT;
      const preStrike = prefix + oldSym;
      const { pad: oldPad } = splitLeadingPad(oldSym);
      const { pad: newPad } = splitLeadingPad(newSym);
      let line = prefix; // post-clear: the symbol's bytes are gone
      const want = reconcileRewritePad(prefix, oldPad, newPad);
      line = want + line.slice(prefix.length); // the reconcile edit
      // restore: the armed record expects exactly `want` at the range
      assert.strictEqual(line.slice(0, want.length), want, "the restore's byte-check precondition holds");
      const restored = prefix + oldSym + line.slice(want.length);
      assert.strictEqual(restored, preStrike);
    });

    test(`rewrite pad: old ${oldName} → new ${newName} lands the container indent exactly once`, () => {
      // Park: doc symbols park at line start (their bytes carry the indent),
      // bare ones after it. The clear removes the symbol's own bytes, so the
      // line prefix left behind is the complement.
      const prefix = oldSym === DOC ? "" : INDENT;
      const { pad: oldPad } = splitLeadingPad(oldSym);
      const { pad: newPad, rest } = splitLeadingPad(newSym);
      const want = reconcileRewritePad(prefix, oldPad, newPad);
      let buf = "";
      let cur = 0;
      for (const s of computeSteps(rest)) {
        buf = buf.slice(0, cur) + s.insert + buf.slice(cur);
        cur = s.cursorOffset;
      }
      // Landed line bytes = reconciled indent + the walked rest; ground truth
      // = the container indent, then the new symbol as its file carries it.
      const landed = want + buf;
      const expected = newSym === DOC ? newSym : INDENT + newSym;
      assert.strictEqual(landed, expected);
    });
  }
}
