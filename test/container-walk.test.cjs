// Unit tests for the container walk (src/disclosure/walk.ts, source-derived layout).
//
// The walk used to open functions only, with synthetic indentation that collapsed
// blank lines — so a class (blank lines between members) fell back to a single
// block ghost. These oracles pin the upgrade: item containers (class/impl/mod)
// walk shape-first with members one by one, layout comes from source bytes so
// blank lines survive, and the whole build replays byte-exact. AST-level Tabs,
// not one blob per class.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const EXTERNALS = ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"];

const bundle = path.join(__dirname, ".container-walk.bundle.cjs");
fs.writeFileSync(
  path.join(__dirname, ".container-walk.entry.ts"),
  `export { computeSteps, walkableSource, cleanWalkRegion } from "../src/disclosure/walk";\n` +
    `export { appendEdit, applyAppend, containerKeyChain } from "../src/disclosure/anchoredInsert";\n` +
    `export { buildRecoveryGhost } from "../src/disclosure/recoveryGhost";\n` +
    `export { RUST, CSHARP, TYPESCRIPT, PYTHON } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, ".container-walk.entry.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: EXTERNALS,
});
const { computeSteps, walkableSource, cleanWalkRegion, appendEdit, applyAppend, buildRecoveryGhost, containerKeyChain, RUST, CSHARP, TYPESCRIPT, PYTHON } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(path.join(__dirname, ".container-walk.entry.ts"), { force: true });
});

const replay = (steps) => {
  let buf = "";
  let cur = 0;
  for (const s of steps) {
    buf = buf.slice(0, cur) + s.insert + buf.slice(cur);
    cur = s.cursorOffset;
  }
  return buf;
};

// Container-shaped sources, each with blank lines between members — the exact
// shape that used to fail the simulation. minSteps proves block-by-block: the
// build takes several gestures, not one.
const CORPUS = [
  {
    name: "csharp: comment + class with consts, blank line, method (DiscountEngine shape)",
    spec: () => CSHARP,
    minSteps: 4,
    code: `// First match wins; rules do not stack.\npublic class DiscountEngine\n{\n    private const int BulkQuantityThreshold = 5;\n    private const decimal BigSpenderThreshold = 500m;\n\n    public decimal DiscountFor(Cart cart)\n    {\n        var subtotal = cart.Subtotal();\n\n        if (subtotal >= BigSpenderThreshold)\n        {\n            return subtotal * 0.05m;\n        }\n\n        return 0m;\n    }\n}`,
  },
  {
    name: "rust: impl with two methods, blank line between",
    spec: () => RUST,
    minSteps: 3,
    code: `impl Reading {\n    pub fn new(room: &'static str, celsius: f64) -> Self {\n        Reading { room, celsius }\n    }\n\n    pub fn fahrenheit(&self) -> f64 {\n        self.celsius * 9.0 / 5.0 + 32.0\n    }\n}`,
  },
  {
    name: "typescript: class with field and method",
    spec: () => TYPESCRIPT,
    minSteps: 3,
    code: `class Cart {\n  items: Item[] = [];\n\n  subtotal(): number {\n    return this.items.reduce((a, i) => a + i.price, 0);\n  }\n}`,
  },
  {
    name: "rust: fn with a blank line between statements (previously unwalkable)",
    spec: () => RUST,
    minSteps: 3,
    code: `fn main() {\n    let x = compute();\n\n    println!("{}", x);\n}`,
  },
];

test("container sources walk byte-exact, block by block", () => {
  for (const c of CORPUS) {
    const spec = c.spec();
    assert.ok(walkableSource(c.code, spec), `${c.name}: must be walkable`);
    const steps = computeSteps(c.code, spec);
    assert.strictEqual(replay(steps), c.code, `${c.name}: replay must be byte-exact`);
    assert.ok(steps.length >= c.minSteps, `${c.name}: expected >= ${c.minSteps} gestures, got ${steps.length}`);
  }
});

test("a container walk opens shape-first: the shell precedes its members", () => {
  const steps = computeSteps(CORPUS[0].code, CSHARP);
  assert.strictEqual(steps[0].kind, "container", "first step is the class shell");
  assert.ok(steps[0].insert.includes("public class DiscountEngine"), "shell carries the header");
  assert.ok(steps[0].insert.trimEnd().endsWith("}"), "shell closes the block");
  // Members re-anchor against the class header, not ROOT.
  assert.ok(
    steps.slice(1).some((s) => s.parentKey.includes("public class DiscountEngine")),
    "members carry the class header as parentKey",
  );
});

test("no-create-walk languages stay non-walkable", () => {
  const py = `class Store:\n    def add(self, x):\n        self.x = x\n`;
  assert.strictEqual(walkableSource(py, PYTHON), false, "python has no create walk");
});

// The recovery path's end-to-end oracle — the twin of walkableSource's
// happy-path simulation. Rebuild the whole symbol the way divergence recovery
// does (first step via the cursor ghost, every later step via the re-anchored
// parent append) and demand byte equality with the source. This is the seam
// the missing-brace and doubled-indent corruptions lived in; neither survives
// a byte-exact rebuild. Corpus layout uses appendEdit's join (single newline
// between siblings, 4-column indent) so equality is exact.
const RECOVERY_CORPUS = [
  {
    name: "csharp: class with two methods (brace on its own line)",
    spec: () => CSHARP,
    code: `public static class DiscountMath\n{\n    public static decimal RoundToCents(decimal amount)\n    {\n        return Math.Round(amount, 2);\n    }\n    public static decimal Clamp(decimal amount)\n    {\n        return Math.Max(amount, 0m);\n    }\n}`,
  },
  {
    name: "rust: fn with a nested loop",
    spec: () => RUST,
    code: `fn sum(xs: &[i32]) -> i32 {\n    let mut total = 0;\n    for x in xs {\n        total += x;\n    }\n    total\n}`,
  },
  {
    name: "rust: impl with a method",
    spec: () => RUST,
    code: `impl Reading {\n    pub fn new(room: &'static str) -> Self {\n        Reading { room }\n    }\n}`,
  },
];

test("recovery assembly rebuilds the symbol byte-exact", () => {
  for (const c of RECOVERY_CORPUS) {
    const spec = c.spec();
    const steps = computeSteps(c.code, spec);
    // Step 0 lands via the cursor ghost on an empty line at column 0.
    let buf = buildRecoveryGhost("", 0, steps[0]).text;
    for (const step of steps.slice(1)) {
      const edit = appendEdit(buf, step.parentKey, step.bareText, spec);
      assert.ok(edit, `${c.name}: appendEdit resolved for ${JSON.stringify(step.bareText.split("\n")[0])}`);
      buf = applyAppend(buf, edit);
    }
    assert.strictEqual(buf, c.code, `${c.name}: recovery-built bytes must equal the source`);
  }
});

test("bareText is column-relative: nested continuation lines carry no source pad", () => {
  const steps = computeSteps(RECOVERY_CORPUS[0].code, CSHARP);
  const method = steps.find((s) => s.bareText.startsWith("public static decimal RoundToCents"));
  assert.strictEqual(
    method.bareText,
    "public static decimal RoundToCents(decimal amount)\n{\n}",
    "the brace line is dedented to the node's own column",
  );
});

test("recovery bareText: the first step carries its leading trivia", () => {
  // A recovery-landed first step must not drop the symbol's doc comments —
  // trivia is the symbol's bytes (the DiscountMath shell landed commentless).
  const src = `// Money helpers in one place.\npublic static class DiscountMath\n{\n    public static decimal RoundToCents(decimal amount)\n    {\n        return Math.Round(amount, 2);\n    }\n}`;
  const steps = computeSteps(src, CSHARP);
  assert.ok(steps[0].bareText.startsWith("// Money helpers in one place."), "prefix rides step 0's bareText");
  assert.ok(steps[0].bareText.trimEnd().endsWith("}"), "and it is still the container shell");
  assert.ok(!steps[1].bareText.startsWith("//"), "later steps carry only their own bytes");
});

test("cleanWalkRegion: a dirty parse yields no verdict, a clean one yields the region", () => {
  // The human's own not-yet-valid code (a syntax the grammar doesn't know)
  // makes error recovery absorb it into neighboring nodes and poisons every
  // container key — the walk must say \"no verdict\", never the wrong container.
  const poisoned = `public struct foobar(string hello);\n\npublic static class DiscountMath\n{\n    \n}\n`;
  assert.strictEqual(cleanWalkRegion(poisoned, CSHARP), undefined, "garbage absorbed into the region → undefined");

  const clean = `public static class DiscountMath\n{\n    \n}\n`;
  const region = cleanWalkRegion(clean, CSHARP);
  assert.ok(region !== undefined && region.trimEnd().endsWith("}"), "clean tail → the walked node's region");
});

test("containerKeyChain: the cursor's ancestors, innermost first — the climb-out test", () => {
  // Caret at the end of the ctor's last statement: the innermost container is
  // the ctor, and the class is on the chain — so a planned method whose parent
  // is the class is a CLIMB-OUT (Tab places structurally), while a foreign
  // container would not be on the chain at all.
  const src = `public class DiscountRule\n{\n    public DiscountRule(string name)\n    {\n        var brrr = 99;\n        Name = name;\n    }\n}`;
  const at = src.indexOf("Name = name;") + "Name = name;".length;
  const chain = containerKeyChain(src, at, CSHARP);
  assert.strictEqual(chain.length, 2, "ctor and class on the chain");
  assert.ok(chain[0].startsWith("public DiscountRule("), "innermost is the ctor");
  assert.strictEqual(chain[1], "public class DiscountRule", "the class is an ancestor — climb-out eligible");

  const outside = containerKeyChain(src, 2, CSHARP); // on the class header line
  assert.deepStrictEqual(outside, [], "outside every block → empty chain");
});

test("cleanWalkRegion: unparseable bytes BELOW the region don't revoke its verdict", () => {
  // The tail runs to end-of-file; a foreign unparseable line after the walked
  // node must not blind the eligibility check (the doll-nesting corruption).
  const below = `public class DiscountRule\n{\n    public DiscountRule(string name)\n    {\n        Name = name;\n    }\n}\n\npublic struct foobar(int a);\n`;
  const region = cleanWalkRegion(below, CSHARP);
  assert.ok(region !== undefined, "region verdict survives garbage below it");
  assert.ok(region.trimEnd().endsWith("}"), "region is the class");
  assert.ok(!region.includes("foobar"), "the garbage is outside the region");
});
