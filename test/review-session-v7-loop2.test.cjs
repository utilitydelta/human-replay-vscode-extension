// Adversarial review evidence, loop 2 (witness rule). A failure is the defect.
// Run: node --test test/review-session-v7-loop2.test.cjs

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".review-session-v7-loop2.bundle.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/disclosure/sandboxProbe.ts")],
  bundle: true, outfile: bundle, format: "cjs", platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { rankSandboxes } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

const memFs = (files) => ({
  readFile: (p) => files[path.resolve(p)],
  listFiles: () => [],
  listDirs: () => [],
});
const step = (id, action, file, symbol) => ({ id, title: id, phase: "P", file, action, symbol, why: "", retro: { question: "", invariants: [] }, line: 1, red: [], green: [] });

const OLD = "fn foo() -> u32 {\n    1\n}\n\nfn baz() -> u32 {\n    1\n}\n";
const HALF = "fn foo() -> u32 {\n    2\n}\n\nfn baz() -> u32 {\n    1\n}\n"; // human landed 1.1

// The human is partway through a guide with no creates and the agent's tree is
// not among the candidates. A base-state copy now differs from the target on
// exactly the step the human already landed, so it counts as a witness. As the
// sandbox it would steer the landed step back to the base bytes.
test("a base-state copy is not proven by the steps the human already landed", () => {
  const fsx = memFs({ "/w/target/src/lib.rs": HALF, "/w/target-old/src/lib.rs": OLD });
  const steps = [step("1.1", "modify", "src/lib.rs", "foo"), step("1.2", "modify", "src/lib.rs", "baz")];
  const v = rankSandboxes(steps, ["/w/target-old"], fsx, "/w/target");
  assert.notStrictEqual(v.kind, "unique", `picked ${v.pick && v.pick.root}, the base copy`);
});
