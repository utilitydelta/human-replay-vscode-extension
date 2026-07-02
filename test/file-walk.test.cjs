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
  `export { planFileWalk } from "../src/disclosure/fileWalk";\n` +
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
const { planFileWalk, RUST, CSHARP, TYPESCRIPT, TSX, PYTHON, MARKDOWN, HTML, CSS } = require(bundle);
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

test("no grammar → one whole-file segment; empty file → none", () => {
  const toml = `[package]\nname = "demo"\n\n[dependencies]\n`;
  const segs = planFileWalk(toml, undefined);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].sep + segs[0].body, toml);

  assert.deepStrictEqual(planFileWalk("", RUST), []);
  assert.deepStrictEqual(planFileWalk("", undefined), []);
});
