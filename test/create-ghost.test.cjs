// The create surface's accept-ability invariant.
//
// A symbol with leading trivia extracts from its LINE START, so its bytes begin
// with the line's indent. VS Code's Tab-commit for inline suggestions is gated
// on `inlineSuggestionHasIndentationLessThanTabSize`: a ghost that leads with a
// full indent CANNOT be Tab-accepted — Tab indents, the typed tab dismisses the
// ghost, and nothing lands (the step 1.3 'park a batch' bug). The runner types
// the pad as real bytes (splitLeadingPad) and serves the rest, so these tests
// pin the pair of invariants that keeps the gesture working:
//   - the first ghost of a create never leads with indentation;
//   - pad + replayed rest is byte-identical to the extracted symbol.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".create-ghost.bundle.cjs");
const entry = path.join(__dirname, ".create-ghost.entry.ts");
fs.writeFileSync(
  entry,
  `export { extractSymbol } from "../src/disclosure/resume";\n` +
    `export { splitLeadingPad } from "../src/disclosure/insertion";\n` +
    `export { computeSteps, walkableSource } from "../src/disclosure/walk";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n` +
    `export { resolveStep } from "../src/disclosure/replay";\n` +
    `export { parseRoot } from "../src/disclosure/diff";\n` +
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
const { extractSymbol, splitLeadingPad, computeSteps, walkableSource, buildReplaySteps, resolveStep, parseRoot, RUST, CSHARP, TYPESCRIPT, PYTHON } =
  require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

function replayWalk(steps) {
  let buf = "";
  let cur = 0;
  for (const s of steps) {
    buf = buf.slice(0, cur) + s.insert + buf.slice(cur);
    cur = s.cursorOffset;
  }
  return buf;
}

function replayOps(buffer, steps, spec) {
  let buf = buffer;
  let selfDelta = 0;
  for (const st of steps) {
    const r = resolveStep(buf, parseRoot(buf, spec), st, selfDelta);
    assert.ok(r, "op must resolve");
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
  }
  return buf;
}

// Nested, trivia-carrying symbols — the shape whose extraction starts with the
// line's indent (the celeriant `push_pending_follower_commit` shape).
const CASES = [
  {
    name: "rust: doc-commented method in an impl",
    spec: RUST,
    symbol: "park",
    file: `pub struct Cache;\n\nimpl Cache {\n    /// Park a batch until confirmed.\n    /// Bounded by the byte counter.\n    pub fn park(&mut self, n: usize) {\n        if n > 0 {\n            self.total += n;\n        }\n        self.count += 1;\n    }\n}\n`,
  },
  {
    name: "csharp: attributed method in a class",
    spec: CSHARP,
    symbol: "Park",
    file: `public class Cache\n{\n    /// <summary>Parks a batch.</summary>\n    [Obsolete("use ParkChecked")]\n    public void Park(int n)\n    {\n        if (n > 0)\n        {\n            _total += n;\n        }\n    }\n}\n`,
  },
  {
    name: "typescript: commented method in a class",
    spec: TYPESCRIPT,
    symbol: "park",
    file: `class Cache {\n  /** Park a batch until confirmed. */\n  park(n: number): void {\n    if (n > 0) {\n      this.total += n;\n    }\n  }\n}\n`,
  },
  {
    name: "python: decorated method in a class (whole-symbol surface)",
    spec: PYTHON,
    symbol: "park",
    file: `class Cache:\n    # bounded parking\n    @guard\n    def park(self, n):\n        if n > 0:\n            self.total += n\n`,
  },
];

for (const c of CASES) {
  test(`create ghost never leads with indentation — ${c.name}`, () => {
    const sym = extractSymbol(c.file, c.symbol, c.spec);
    assert.ok(sym !== undefined, "corpus symbol must resolve");
    const { pad, rest } = splitLeadingPad(sym);
    assert.ok(pad.length > 0, "corpus must be the indented, trivia-carrying shape");
    assert.strictEqual(pad + rest, sym, "the split invents and drops nothing");
    assert.ok(!/^[ \t]/.test(rest), "the served bytes start at the first visible column");

    if (walkableSource(rest, c.spec, pad.length)) {
      const steps = computeSteps(rest, c.spec, pad.length);
      assert.ok(!/^[ \t]/.test(steps[0].insert), "the first walk ghost must be Tab-acceptable");
      assert.strictEqual(pad + replayWalk(steps), sym, "pad + walk is byte-identical to the symbol");
    } else {
      const steps = buildReplaySteps("", rest, c.spec);
      assert.ok(!/^[ \t]/.test(steps[0].replacement), "the whole-symbol ghost must be Tab-acceptable");
      assert.strictEqual(pad + replayOps("", steps, c.spec), sym, "pad + block insert is byte-identical to the symbol");
    }
  });
}

// A symbol with no leading indent (top-level, or no trivia so extraction starts
// at the item) splits to an empty pad — the runner types nothing.
test("splitLeadingPad: no indent means no pad", () => {
  assert.deepStrictEqual(splitLeadingPad("fn f() {}\n"), { pad: "", rest: "fn f() {}\n" });
  assert.deepStrictEqual(splitLeadingPad(""), { pad: "", rest: "" });
});
