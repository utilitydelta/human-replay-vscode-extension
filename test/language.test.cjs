// Multi-language oracles (src/disclosure/language.ts + the threaded engine).
//
// The engine's language knowledge lives in one registry; everything else diffs
// and replays whatever parse it is handed. These tests pin, per language, the
// invariants the replay leans on:
//   - extractSymbol finds the named item WITH its attached bytes (doc comments,
//     attributes, decorators, export keywords) and returns undefined when absent;
//   - a modify pair replays byte-exact through the controller's exact sequential
//     policy (resolveStep + selfDelta) — no collision mid-walk;
//   - a small change classifies surgical (the cutover math is language-neutral);
//   - the create path: brace languages walk (steps rebuild the symbol
//     byte-exact); non-walkable languages land the whole symbol as one op.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".language.bundle.cjs");
const entry = path.join(__dirname, ".language.entry.ts");
fs.writeFileSync(
  entry,
  `export { extractSymbol, stepAlreadyLanded } from "../src/disclosure/resume";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n` +
    `export { classifyReplay } from "../src/disclosure/strategy";\n` +
    `export { resolveStep } from "../src/disclosure/replay";\n` +
    `export { parseRoot } from "../src/disclosure/diff";\n` +
    `export { computeSteps } from "../src/disclosure/walk";\n` +
    `export { RUST, CSHARP, TYPESCRIPT, PYTHON, MARKDOWN, languageForFile } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown"],
});
const { extractSymbol, buildReplaySteps, classifyReplay, resolveStep, parseRoot, computeSteps, CSHARP, TYPESCRIPT, PYTHON, MARKDOWN, languageForFile } =
  require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

// The controller's exact interactive loop (mirrors sequential-replay.test.cjs).
function replayControllerPolicy(buffer, steps, spec) {
  let buf = buffer;
  let selfDelta = 0;
  for (const [i, st] of steps.entries()) {
    const r = resolveStep(buf, parseRoot(buf, spec), st, selfDelta);
    assert.ok(r, `step ${i} must resolve (null = the collision modal)`);
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
  }
  return buf;
}

// Walk contract: insert at cursor, move cursor (mirrors walk.test.cjs).
function replayWalk(steps) {
  let buf = "";
  let cur = 0;
  for (const s of steps) {
    buf = buf.slice(0, cur) + s.insert + buf.slice(cur);
    cur = s.cursorOffset;
  }
  return buf;
}

// --- corpus: per language --------------------------------------------------
// file: full file text on the target side. symbol: the addressable name.
// expectContains: bytes that MUST ride with the extracted symbol (trivia/lift).
// fileAfter: sandbox side of a modify. walkSymbol: bare create-walk input for
// brace languages (undefined = whole-symbol create).

const CS_FILE = (body) => `using System;\n\nnamespace Demo;\n\npublic class Calc\n{\n    private int _x;\n\n${body}\n}\n`;
const CS_ADD = `    /// <summary>Accumulates positives.</summary>\n    [Obsolete("use AddChecked")]\n    public int Add(int a)\n    {\n        if (a > 0)\n        {\n            _x += a;\n        }\n        return _x;\n    }`;
const CS_ADD_EDITED = CS_ADD.replace("_x += a;", "_x += a * 2;");

const TS_FILE = (body) => `import { xs } from "./xs";\n\n${body}\n\nclass Svc {\n  run(): void {}\n}\n`;
const TS_ADD = `/** Accumulate xs. */\nexport function add(a: number): number {\n  const start = a;\n  const limit = 100;\n  for (const x of xs) {\n    a += x;\n  }\n  if (a > limit) {\n    a = limit;\n  }\n  logDelta(start, a);\n  return a;\n}`;
const TS_ADD_EDITED = TS_ADD.replace("a += x;", "a += x * 2;");

const PY_FILE = (body) => `import math\n\n${body}\n\nclass Svc:\n    def run(self):\n        pass\n`;
const PY_ADD = `# accumulator helper\n@retry(times=3)\ndef add(a):\n    """Add positives."""\n    if a > 0:\n        a += 1\n    return a`;
const PY_ADD_EDITED = PY_ADD.replace("a += 1", "a += 2");

const MD_FILE = (setup) => `# Guide\n\nIntro paragraph.\n\n${setup}\n## Usage\n\nRun the thing.\n`;
const MD_SETUP = `## Setup\n\nInstall the runtime.\n\nThen configure the sandbox with the defaults.\n\nPoint the tool at the sandbox folder.\n\nOpen the target repo before starting a replay.\n\nThe status bar shows the position.\n\n`;
const MD_SETUP_EDITED = `## Setup\n\nInstall the runtime and the grammar pack.\n\nThen configure the sandbox with the defaults.\n\nPoint the tool at the sandbox folder.\n\nOpen the target repo before starting a replay.\n\nThe status bar shows the position.\n\n`;

const CASES = [
  {
    spec: CSHARP,
    name: "csharp",
    symbol: "Add",
    file: CS_FILE(CS_ADD),
    fileAfter: CS_FILE(CS_ADD_EDITED),
    expectContains: ["/// <summary>", "[Obsolete", "public int Add"],
    walkSymbol: `int Add(int a)\n{\n    if (a > 0)\n    {\n        _x += a;\n    }\n    return _x;\n}`,
  },
  {
    spec: TYPESCRIPT,
    name: "typescript",
    symbol: "add",
    file: TS_FILE(TS_ADD),
    fileAfter: TS_FILE(TS_ADD_EDITED),
    expectContains: ["/** Accumulate xs. */", "export function add"],
    walkSymbol: `function add(a: number): number {\n  const start = a;\n  for (const x of xs) {\n    a += x;\n  }\n  return a;\n}`,
  },
  {
    spec: PYTHON,
    name: "python",
    symbol: "add",
    file: PY_FILE(PY_ADD),
    fileAfter: PY_FILE(PY_ADD_EDITED),
    expectContains: ["# accumulator helper", "@retry(times=3)", "def add(a):"],
    walkSymbol: undefined, // no walk: create lands whole-symbol
  },
  {
    spec: MARKDOWN,
    name: "markdown",
    symbol: "Setup",
    file: MD_FILE(MD_SETUP),
    fileAfter: MD_FILE(MD_SETUP_EDITED),
    expectContains: ["## Setup", "Install the runtime."],
    walkSymbol: undefined,
  },
];

for (const c of CASES) {
  test(`${c.name}: extractSymbol returns the item with its attached bytes`, () => {
    const got = extractSymbol(c.file, c.symbol, c.spec);
    assert.ok(got !== undefined, "symbol must resolve");
    for (const frag of c.expectContains) {
      assert.ok(got.includes(frag), `extracted symbol must carry ${JSON.stringify(frag)}\ngot:\n${got}`);
    }
    assert.ok(c.file.includes(got), "extraction is a byte-exact slice of the file");
  });

  test(`${c.name}: an absent symbol resolves to undefined, never a guess`, () => {
    assert.strictEqual(extractSymbol(c.file, "no_such_symbol_xyz", c.spec), undefined);
  });

  test(`${c.name}: modify replays byte-exact through the sequential controller policy`, () => {
    const before = extractSymbol(c.file, c.symbol, c.spec);
    const after = extractSymbol(c.fileAfter, c.symbol, c.spec);
    assert.ok(before && after && before !== after, "corpus must be a real modify");
    const steps = buildReplaySteps(before, after, c.spec);
    assert.ok(steps.length >= 1, "expected at least one op");
    assert.strictEqual(replayControllerPolicy(before, steps, c.spec), after);
  });

  test(`${c.name}: a small change classifies surgical`, () => {
    const before = extractSymbol(c.file, c.symbol, c.spec);
    const after = extractSymbol(c.fileAfter, c.symbol, c.spec);
    assert.strictEqual(classifyReplay(before, after, c.spec).strategy, "surgical");
  });

  test(`${c.name}: create path is ground-truth byte-exact`, () => {
    if (c.walkSymbol !== undefined) {
      // Brace language: the disclosure walk rebuilds the symbol byte-exact.
      const final = replayWalk(computeSteps(c.walkSymbol, c.spec));
      assert.strictEqual(final, c.walkSymbol);
    } else {
      // No walk: an empty Before yields ops that land the whole symbol.
      const sym = extractSymbol(c.fileAfter, c.symbol, c.spec);
      const steps = buildReplaySteps("", sym, c.spec);
      assert.strictEqual(replayControllerPolicy("", steps, c.spec), sym);
    }
  });
}

test("languageForFile: extension routing, unknown fails closed", () => {
  assert.strictEqual(languageForFile("a/b.rs").id, "rust");
  assert.strictEqual(languageForFile("a/b.cs").id, "csharp");
  assert.strictEqual(languageForFile("a/b.ts").id, "typescript");
  assert.strictEqual(languageForFile("a/b.tsx").id, "tsx");
  assert.strictEqual(languageForFile("a/b.js").id, "typescript");
  assert.strictEqual(languageForFile("a/b.py").id, "python");
  assert.strictEqual(languageForFile("docs/guide.md").id, "markdown");
  assert.strictEqual(languageForFile("setup.sh"), undefined);
  assert.strictEqual(languageForFile("Makefile"), undefined);
});

test("markdown: nested section resolves by heading text, not position", () => {
  const md = `# Top\n\n## A\n\naaa\n\n### A child\n\nccc\n\n## B\n\nbbb\n`;
  const b = extractSymbol(md, "B", MARKDOWN);
  assert.ok(b && b.startsWith("## B"), "found by heading text");
  const child = extractSymbol(md, "A child", MARKDOWN);
  assert.ok(child && child.startsWith("### A child"), "nested heading resolves");
});
