// Unit tests for the file-walk segmentation (src/disclosure/fileWalk.ts).
//
// A create-file step discloses a new file segment by segment instead of dropping
// it whole. These oracles pin the cut: segments concatenate back to the file
// byte-exact (ground truth, invariant 1), separators are whitespace the runner
// types, and the grouping follows blank lines — an import block or an attached
// comment rides with its item, a detached block stands alone. Parameterized over
// every supported language plus the no-grammar fallback.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const EXTERNALS = ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"];

const bundle = path.join(__dirname, ".file-walk.bundle.cjs");
fs.writeFileSync(
  path.join(__dirname, ".file-walk.entry.ts"),
  `export { planFileWalk, resumeIndex, splitTrailing } from "../src/disclosure/fileWalk";\n` +
    `export { walkableSource } from "../src/disclosure/walk";\n` +
    `export { splitLeadingPad } from "../src/disclosure/insertion";\n` +
    `export { RUST, CSHARP, TYPESCRIPT, TSX, PYTHON, MARKDOWN, HTML, CSS } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, ".file-walk.entry.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: EXTERNALS,
});
const { planFileWalk, resumeIndex, splitTrailing, walkableSource, splitLeadingPad, RUST, CSHARP, TYPESCRIPT, TSX, PYTHON, MARKDOWN, HTML, CSS } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(path.join(__dirname, ".file-walk.entry.ts"), { force: true });
});

// Each corpus entry: source, its language spec, the expected number of segments,
// and a marker substring each segment's body must start with (the grouping proof).
const CORPUS = [
  {
    name: "rust: mods group, comment rides its fn, struct stands alone",
    spec: () => RUST,
    starts: ["mod sensor;", "use sensor::Reading;", "pub struct Summary {", "// summarize walks"],
    code: `mod sensor;\nmod stats;\n\nuse sensor::Reading;\n\npub struct Summary {\n    pub min: f64,\n}\n\n// summarize walks the batch once.\nfn summarize(xs: &[f64]) -> f64 {\n    let mut sum = 0.0;\n    for x in xs {\n        sum += x;\n    }\n    sum\n}\n`,
  },
  {
    name: "rust: detached comment block is its own segment",
    spec: () => RUST,
    starts: ["// A detached design note.", "fn later() {"],
    code: `// A detached design note.\n// It ends at the blank line.\n\nfn later() {\n    work();\n}\n`,
  },
  {
    name: "csharp: namespace line, comment + class group",
    spec: () => CSHARP,
    starts: ["namespace DemoShop;", "// First match wins."],
    code: `namespace DemoShop;\n\n// First match wins.\npublic class DiscountEngine\n{\n    public decimal DiscountFor(Cart cart)\n    {\n        return 0m;\n    }\n}\n`,
  },
  {
    name: "tsx: import block groups, component stands alone",
    spec: () => TSX,
    starts: ["import { useState }", "export default function App()"],
    code: `import { useState } from "react";\nimport Counter from "./components/Counter";\n\nexport default function App() {\n  const [name, setName] = useState("world");\n  return <div>{name}</div>;\n}\n`,
  },
  {
    name: "python: docstring, imports, class, function",
    spec: () => PYTHON,
    starts: [`"""Module doc."""`, "import sys", "class Store:", "def main() -> int:"],
    code: `"""Module doc."""\n\nimport sys\nimport os\n\nclass Store:\n    def add(self, x):\n        self.x = x\n\ndef main() -> int:\n    return 0\n`,
  },
  {
    name: "markdown: heading, prose, and subsections each stand alone",
    spec: () => MARKDOWN,
    starts: ["# Title", "Intro prose.", "## Second", "## Third"],
    code: `# Title\n\nIntro prose.\n\n## Second\n\nBody two.\n\n## Third\n\nBody three.\n`,
  },
  {
    name: "css: blank-line-separated rules split, adjacent rules group",
    spec: () => CSS,
    starts: ["body {", ".app {"],
    code: `body {\n  margin: 0;\n}\n\n.app {\n  color: red;\n}\n.app-tight {\n  color: blue;\n}\n`,
  },
  {
    name: "html: whole document in few gestures",
    spec: () => HTML,
    starts: ["<!doctype html>"],
    code: `<!doctype html>\n<html>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n`,
  },
];

test("segments concatenate back to the file byte-exact", () => {
  for (const c of CORPUS) {
    const segs = planFileWalk(c.code, c.spec());
    const rebuilt = segs.map((s) => s.sep + s.body).join("");
    assert.strictEqual(rebuilt, c.code, `${c.name}: rebuilt bytes must equal the source`);
  }
});

test("separators are whitespace-only (typed, never ghosted)", () => {
  for (const c of CORPUS) {
    for (const [i, s] of planFileWalk(c.code, c.spec()).entries()) {
      assert.match(s.sep, /^\s*$/, `${c.name} segment ${i}: sep must be whitespace`);
      assert.notStrictEqual(s.body, "", `${c.name} segment ${i}: body must carry content`);
    }
  }
});

test("blank lines cut segments; adjacent lines group", () => {
  for (const c of CORPUS) {
    const segs = planFileWalk(c.code, c.spec());
    assert.strictEqual(segs.length, c.starts.length, `${c.name}: segment count`);
    c.starts.forEach((prefix, i) => {
      assert.ok(
        segs[i].body.startsWith(prefix),
        `${c.name} segment ${i}: expected body to start with ${JSON.stringify(prefix)}, got ${JSON.stringify(segs[i].body.slice(0, 40))}`,
      );
    });
  }
});

test("resume lands only on segment boundaries", () => {
  const c = CORPUS[0]; // the rust corpus: 4 segments
  const segs = planFileWalk(c.code, c.spec());
  assert.strictEqual(resumeIndex(segs, ""), 0, "an empty target starts from the top");
  let built = "";
  for (const [i, s] of segs.entries()) {
    built += s.sep + s.body;
    assert.strictEqual(resumeIndex(segs, built), i + 1, `boundary after segment ${i}`);
    if (i < segs.length - 1) {
      assert.strictEqual(resumeIndex(segs, built + segs[i + 1].sep), undefined, "mid-segment prefix is a conflict");
    }
  }
  assert.strictEqual(resumeIndex(segs, "unrelated bytes"), undefined, "a foreign file is a conflict");
});

// Which surface each segment rides after the runner's trailing-whitespace split —
// the file's final newline is typed, so a last segment holding a class or fn
// must WALK, not fall back to a block ghost. One fixture per walk language plus
// the no-create-walk negatives.
const ROUTING = [
  {
    name: "csharp: comment + class walks; namespace line blocks",
    spec: () => CSHARP,
    walks: [false, true],
    code: `namespace DemoShop;\n\n// First match wins.\npublic class DiscountEngine\n{\n    private const int Threshold = 5;\n\n    public decimal DiscountFor(Cart cart)\n    {\n        return 0m;\n    }\n}\n`,
  },
  {
    name: "tsx: imports and interface block; exported component walks",
    spec: () => TSX,
    walks: [false, false, true],
    code: `import { useState } from "react";\n\nexport interface Todo {\n  id: number;\n}\n\nexport default function TodoList() {\n  const [n, setN] = useState(0);\n  return <div>{n}</div>;\n}\n`,
  },
  {
    name: "rust: doc header and struct block; pub fn walks",
    spec: () => RUST,
    walks: [false, false, true],
    code: `//! Stats.\n\npub struct Summary {\n    pub min: f64,\n}\n\npub fn summarize(xs: &[f64]) -> f64 {\n    let mut s = 0.0;\n    for x in xs {\n        s += x;\n    }\n    s\n}\n`,
  },
  {
    name: "python: everything blocks (no create walk)",
    spec: () => PYTHON,
    walks: [false, false],
    code: `import sys\n\ndef main() -> int:\n    return 0\n`,
  },
];

test("segment routing: walkable content walks in every walk language", () => {
  for (const c of ROUTING) {
    const spec = c.spec();
    const segs = planFileWalk(c.code, spec);
    assert.strictEqual(segs.length, c.walks.length, `${c.name}: segment count`);
    segs.forEach((s, i) => {
      const { rest } = splitLeadingPad(s.body);
      const { content, tail } = splitTrailing(rest);
      assert.strictEqual(content + tail, rest, `${c.name} segment ${i}: split is lossless`);
      const walks = content !== "" && walkableSource(content, spec);
      assert.strictEqual(walks, c.walks[i], `${c.name} segment ${i}: expected ${c.walks[i] ? "walk" : "block ghost"}`);
    });
  }
});

test("no grammar → one whole-file segment; empty file → none", () => {
  const toml = `[package]\nname = "demo"\n\n[dependencies]\n`;
  const segs = planFileWalk(toml, undefined);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].sep + segs[0].body, toml);

  assert.deepStrictEqual(planFileWalk("", RUST), []);
  assert.deepStrictEqual(planFileWalk("", undefined), []);
});
