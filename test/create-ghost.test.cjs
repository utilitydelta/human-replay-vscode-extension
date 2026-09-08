// The create surface's accept-ability invariant.
//
// VS Code's Tab-commit for inline suggestions is gated on
// `inlineSuggestionHasIndentationLessThanTabSize`: a ghost that leads with a
// full indent CANNOT be Tab-accepted — Tab indents, the typed tab dismisses the
// ghost, and nothing lands (the step 1.3 'park a batch' bug). Extraction is what
// keeps that from happening: a symbol's bytes start at its first VISIBLE byte,
// trivia or no trivia, so the served ghost never opens with whitespace and the
// column comes from the target (planCreateInsertion's scaffold). splitLeadingPad
// stays as the belt: whatever leading whitespace does reach the surface is typed
// as real bytes, never ghosted. These tests pin the invariants that keep the
// gesture working, over the nested, trivia-carrying shapes that used to break it:
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
  const ledger = [];
  for (const st of steps) {
    const r = resolveStep(buf, parseRoot(buf, spec), st, selfDelta, ledger);
    assert.ok(r, "op must resolve");
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
    ledger.push({ offset: r[0], rangeLength: r[1] - r[0], textLength: st.replacement.length, self: true });
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
    assert.ok(/^\S/.test(sym), "extraction starts at the symbol's first visible byte, indent excluded");
    const { pad, rest } = splitLeadingPad(sym);
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

// The runner's `if (pad) { type it as real bytes }` branch is NOT dead code:
// extraction never produces a pad, but a SELF-CONTAINED guide's After fence
// carries whatever the author wrote between the backticks, indent included, and
// those bytes reach the create path without passing through extraction. This is
// that branch's only remaining input, so it is the one this pins.
test("create ghost: fenced bytes carrying their own indent still split, land, and stay Tab-acceptable", () => {
  const fenced = `    /// Parks a batch.\n    pub fn parked(&mut self, n: u64) {\n        self.bytes += n;\n    }`;
  const { pad, rest } = splitLeadingPad(fenced);
  assert.strictEqual(pad, "    ", "the author's indent is the pad the runner types as real bytes");
  assert.strictEqual(pad + rest, fenced, "the split invents and drops nothing");
  assert.ok(!/^[ \t]/.test(rest), "the served ghost opens on a committable byte");
  assert.ok(walkableSource(rest, RUST), "and the rest still routes to the walk");
  const steps = computeSteps(rest, RUST);
  assert.ok(!/^[ \t]/.test(steps[0].insert), "the first walk ghost must be Tab-acceptable");
  assert.strictEqual(pad + replayWalk(steps), fenced, "pad + walk is byte-identical to the fenced bytes");
});

// A symbol with no leading indent (every extracted one, and a fence written at
// column 0) splits to an empty pad — the runner types nothing.
test("splitLeadingPad: no indent means no pad", () => {
  assert.deepStrictEqual(splitLeadingPad("fn f() {}\n"), { pad: "", rest: "fn f() {}\n" });
  assert.deepStrictEqual(splitLeadingPad(""), { pad: "", rest: "" });
});
