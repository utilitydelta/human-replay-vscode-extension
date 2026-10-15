// What a symbol's bytes start with: the doc comments and attributes attached
// above it, and an attribute on its own line, but never a sibling item.
//
// Grammars put attributes, decorators and comments BESIDE the item node, so
// extraction walks up the source line by line (leadingTriviaStart). A line is
// attached only when it is nothing but trivia: `#[inline] pub fn get() {..}`
// starts with an attribute but is a whole item. Reading it as trivia made a
// Create of one `#[inline]` one-liner retype every one-liner above it.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".attached-trivia.bundle.cjs");
const entry = path.join(__dirname, ".attached-trivia.entry.ts");
fs.writeFileSync(
  entry,
  `export { extractSymbol } from "../src/disclosure/resume";\n` +
    `export { computeSteps } from "../src/disclosure/walk";\n` +
    `export { RUST, CSHARP, TYPESCRIPT, PYTHON, CSS, HTML } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { extractSymbol, computeSteps, RUST, CSHARP, TYPESCRIPT, PYTHON, CSS, HTML } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

function table(label, spec, rows) {
  // columns: case, source, item, the item's extracted bytes
  for (const [name, src, item, want] of rows) {
    test(`${label}: ${name}`, () => assert.strictEqual(extractSymbol(src, item, spec), want));
  }
}

const ONE_LINERS = `impl Position {
    pub const SENTINEL: Self = Self::new(0);
    #[inline] pub const fn new(raw: u64) -> Self { Self(raw) }
    #[inline] pub const fn get(self) -> u64 { self.0 }
    #[inline] pub fn read_to(self, end: Self) -> u64 { end.0 - self.0 }
}
`;

table("rust", RUST, [
  ["one-liner siblings stay out", ONE_LINERS, "read_to", "#[inline] pub fn read_to(self, end: Self) -> u64 { end.0 - self.0 }"],
  ["the first one-liner stops at the const", ONE_LINERS, "new", "#[inline] pub const fn new(raw: u64) -> Self { Self(raw) }"],
  ["attribute line attaches", "fn a() {}\n\n#[inline]\nfn t() {}\n", "t", "#[inline]\nfn t() {}"],
  ["several attribute lines attach", "#[inline]\n#[must_use]\n#[allow(dead_code)]\nfn t() {}\n", "t", "#[inline]\n#[must_use]\n#[allow(dead_code)]\nfn t() {}"],
  ["nested brackets attach", "#[cfg_attr(test, derive(PartialEq))]\nstruct T([u8; 4]);\n", "T", "#[cfg_attr(test, derive(PartialEq))]\nstruct T([u8; 4]);"],
  ["a bracket in an attribute string", '#[cfg(feature = "x]")]\nfn t() {}\n', "t", '#[cfg(feature = "x]")]\nfn t() {}'],
  ["attribute then line comment attaches", "#[inline] // hot\nfn t() {}\n", "t", "#[inline] // hot\nfn t() {}"],
  ["two attributes on a line attach", "#[inline] #[must_use]\nfn t() {}\n", "t", "#[inline] #[must_use]\nfn t() {}"],
  ["doc comment above a one-liner stays with it", "/// h\n#[inline] fn h() {}\n/// t\nfn t() {}\n", "t", "/// t\nfn t() {}"],
  ["multi-line attribute attaches whole", '#[cfg(any(\n    feature = "a",\n    feature = "b",\n))]\nfn t() {}\n', "t", '#[cfg(any(\n    feature = "a",\n    feature = "b",\n))]\nfn t() {}'],
  ["a bracket in a comment inside a multi-line attribute", '#[cfg(any(\n    feature = "a", // TODO )\n))]\nfn t() {}\n', "t", '#[cfg(any(\n    feature = "a", // TODO )\n))]\nfn t() {}'],
  ["multi-line attribute ending in code is an item", "#[cfg(any(\n    a,\n))] fn h() {}\nfn t() {}\n", "t", "fn t() {}"],
  ["attribute, block comment, code is an item", "impl X {\n    #[inline] /* c */ pub fn h() {}\n    pub fn t() {}\n}\n", "t", "pub fn t() {}"],
  ["block comment then a sibling on the same line", "/* a */ fn h() {} fn t() {}\n", "t", "fn t() {}"],
  ["a deref statement above is code", "fn o() {\n    *p = 1;\n    fn t() {}\n}\n", "t", "fn t() {}"],
  ["a deref statement before it on the line is code", "fn o() {\n    *p = 1; fn t() {}\n}\n", "t", "fn t() {}"],
  ["lifetime in attribute args", "impl X {\n    #[bound(T: 'static)] pub fn h() {}\n    pub fn t() {}\n}\n", "t", "pub fn t() {}"],
  ["raw string ending in a backslash", 'impl X {\n    #[doc = r"C:\\"] pub fn h() {}\n    pub fn t() {}\n}\n', "t", "pub fn t() {}"],
  ["raw string with an inner quote", 'impl X {\n    #[doc = r#"say "hi"#] pub fn h() {}\n    pub fn t() {}\n}\n', "t", "pub fn t() {}"],
  ["a string line that looks like an attribute", 'const S: &str = "\n#[x\n";\nfn t() {}\n', "t", "fn t() {}"],
  ["a raw string holding an attribute opener", 'const S: &str = r#"\n#[cfg(any(\n    a,\n"#;\nfn t() {}\n', "t", "fn t() {}"],
  ["CRLF one-liners", "impl X {\r\n    #[inline] pub fn a() {}\r\n    #[inline] pub fn t() {}\r\n}\r\n", "t", "#[inline] pub fn t() {}"],
  ["CRLF multi-line attribute", "fn a() {}\r\n#[cfg(any(\r\n    a,\r\n))]\r\nfn t() {}\r\n", "t", "#[cfg(any(\r\n    a,\r\n))]\r\nfn t() {}"],
]);

table("csharp", CSHARP, [
  ["one-liner [Fact] method stays out", "class T {\n    [Fact] public void A() {}\n    [Fact]\n    public void B() {}\n}\n", "B", "[Fact]\n    public void B() {}"],
  ["one-liner properties stay out", "class T {\n    [Ignore] public int A { get; set; }\n    [Ignore] public int B { get; set; }\n}\n", "B", "[Ignore] public int B { get; set; }"],
  ["a bracket in an attribute string", 'class T {\n    [Obsolete("x]")] public void A() {}\n    public void B() {}\n}\n', "B", "public void B() {}"],
  ["verbatim string ending in a backslash", 'class T {\n    [Obsolete(@"C:\\")] public void A() {}\n    public void B() {}\n}\n', "B", "public void B() {}"],
  ["a verbatim string line that looks like an attribute", 'class T {\n    const string S = @"\n[abc\n";\n    void B() {}\n}\n', "B", "void B() {}"],
]);

const decorated = (line) => [`decorator \`${line}\` attaches`, `class T {\n  /** d */\n  ${line}\n  b() {}\n}\n`, "b", `/** d */\n  ${line}\n  b() {}`];

table("typescript", TYPESCRIPT, [
  ["one-liner decorated method stays out", "class T {\n  @dec() a() {}\n  @dec()\n  b() {}\n}\n", "b", "@dec()\n  b() {}"],
  ["several one-liners stay out", "class T {\n  @dec() a() {}\n  @dec() c() {}\n  @dec() b() {}\n}\n", "b", "@dec() b() {}"],
  decorated("@Dec<T>()"),
  decorated("@a()()"),
  decorated("@(x.y)"),
  decorated("@Dec<(x: number) => void>()"),
  decorated('@Dec<"a>b">()'),
  decorated("@a(`${`]`}`)"),
  decorated("@a(/]/)"),
  ["a comment above a const attaches", "// c\nconst x = 1;\n", "x", "// c\nconst x = 1;"],
  ["a template line that looks like a decorator", "const s = `\n@Dec(\n`;\nfunction t() {}\n", "t", "function t() {}"],
]);

table("python", PYTHON, [
  ["decorator lines attach", "def a():\n    pass\n\n@staticmethod\n@cache\ndef t():\n    pass\n", "t", "@staticmethod\n@cache\ndef t():\n    pass"],
]);

table("css", CSS, [
  ["comment then a rule on the line above is code", "/* a */ .x { y: 1 }\n.b { x: 1 }\n", ".b", ".b { x: 1 }"],
  ["comment then a sibling rule on its line", "/* a */ .x { y: 1 } .b { x: 1 }\n", ".b", ".b { x: 1 }"],
]);

table("html", HTML, [
  ["comment then a sibling element on its line", '<!-- c --> <span>x</span> <div id="d"></div>\n', "div#d", '<div id="d"></div>'],
]);

// columns: language, line, attached trivia
const LINES = [
  [RUST, "#[inline]", true],
  [RUST, "#[cfg(x)] // c", true],
  [RUST, "/* a */ #[inline]", true],
  [RUST, "#[cfg(any(", true],
  [RUST, '#[doc = r#"a "] b"#]', true],
  [RUST, "#[a = '\\'']", true],
  [RUST, "#[x(for<'a> fn(&'a ()))]", true],
  [RUST, "#[inline] pub fn get(self) -> u64 { self.0 }", false],
  [RUST, "*/ fn x() {}", false],
  [RUST, "/* a */ fn f() {}", false],
  [CSHARP, "[Fact]", true],
  [CSHARP, '[A($"{x[0]}")]', true],
  [CSHARP, '[A(@"a""]")]', true],
  [CSHARP, "[A] public int X => 1;", false],
  [TYPESCRIPT, "@a(() => 1)", true],
  [TYPESCRIPT, "@a.b?.c!()", true],
  [TYPESCRIPT, "* @param x", true],
  [TYPESCRIPT, "@a() b() {}", false],
  [PYTHON, "@a(x) # c (", true],
  [PYTHON, '@a("#")', true],
];
for (const [spec, line, trivia] of LINES) {
  test(`${spec.id}: \`${line}\` is ${trivia ? "" : "not "}attached trivia`, () => assert.strictEqual(spec.isTriviaLine(line), trivia));
}

test("typescript: a container walk folds a decorator into its method's step", () => {
  const inserts = computeSteps("class T {\n  @Dec<T>()\n  b() {\n    x();\n  }\n}", TYPESCRIPT).map((s) => s.insert);
  assert.ok(!inserts.includes("@Dec<T>()"), `decorator disclosed alone: ${JSON.stringify(inserts)}`);
});
