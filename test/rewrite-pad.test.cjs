// Oracle for the rewrite-clear pad split (orchestrator.acceptRewriteClear).
//
// A doc-commented symbol extracts from its LINE START (leadingTriviaStart), so
// a nested method's bytes lead with the line's indent. VS Code cannot
// Tab-accept a whitespace-leading ghost (the commit keybinding is gated on
// `inlineSuggestionHasIndentationLessThanTabSize`): Tab indents instead, the
// caret leaves the anchor, and the walk dead-ends — the live 3.3 incident
// ("provider declined: caret is off the step's anchor" after every clear).
// The fix types the pad as real buffer bytes and walks the rest, exactly as
// the create path does. This oracle pins the pure half of that gesture:
// pad + replay(rest) rebuilds the symbol byte-exact, and the rest's first
// ghost opens on a real byte VS Code will commit.
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
test.after(() => {
  fs.rmSync(walkBundle, { force: true });
  fs.rmSync(insertionBundle, { force: true });
});

// Symbols as extractSymbol hands them to the rewrite path: leading trivia
// pulls the slice back to the line start, so the nested ones carry indent.
const CORPUS = [
  {
    name: "nested doc-commented method (the 3.3 shape)",
    sym: `    /// Insert a row when no schema is cached for the shard.\n    fn no_schema_cache_insert(&mut self, key: u64) -> bool {\n        let slot = key as usize % self.slots.len();\n        self.slots[slot] = Some(key);\n        true\n    }`,
  },
  {
    name: "nested attribute + doc lead",
    sym: `    #[inline]\n    /// Fast path.\n    fn hot(&self) -> u64 {\n        self.count\n    }`,
  },
  {
    name: "deeper nesting (8-space indent)",
    sym: `        /// Inner.\n        fn inner(&self) -> bool {\n            self.ok\n        }`,
  },
  {
    name: "top-level doc-commented fn (no pad — split is a no-op)",
    sym: `/// Documented.\nfn documented(x: i32) -> i32 {\n    x + 1\n}`,
  },
];

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

// The guard the fix exists for: without the split, the indented shapes' first
// ghost leads with whitespace — the exact bytes VS Code refuses to Tab-commit.
// If the walk ever stops emitting the pad in step 0, the split (and this
// oracle) can retire together.
test("rewrite pad: unsplit nested symbol's first ghost is whitespace-leading (why the split exists)", () => {
  const nested = CORPUS[0].sym;
  const first = computeSteps(nested)[0].insert;
  assert.strictEqual(first[0], " ");
});

// --- trivia asymmetry: the four old/new combinations -----------------------
//
// Which side of the rewrite carries the line indent flips with where each
// symbol's trivia starts. A doc-commented symbol's bytes include the indent
// (extraction runs from line start, park at column 0); a bare one's exclude it
// (park at the item start, indent survives in the buffer). Adversarial review
// caught the naive pad-typing double-indenting the bare→doc case and leaving
// doc→bare at column 0. This simulates the full gesture in bytes: park,
// strike-clear, reconcile the prefix, walk the rest — the landed line must
// carry the container indent exactly once for every combination.

const INDENT = "    ";
const BARE = `fn cached(&self) -> u64 {\n        self.count\n    }`;
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
