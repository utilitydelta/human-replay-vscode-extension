// Adversarial review evidence for session-v7 (sandbox probe). Each test
// asserts the behaviour the ground-truth invariant needs; a failure is the
// defect. Not part of the contract's own oracle.
//
// Run: node --test test/review-session-v7.test.cjs

const test = require("node:test");
const assert = require("node:assert");
// The fake trees use POSIX paths on every OS: the module and the fake
// filesystem both run on path.posix, so Windows CI reads "/w/t" as written.
const nativePath = require("path");
const path = nativePath.posix;
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = nativePath.join(__dirname, ".review-session-v7.bundle.cjs");
esbuild.buildSync({
  entryPoints: [nativePath.join(__dirname, "../src/disclosure/sandboxProbe.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  alias: { path: "path/posix" },
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { sessionGuides, candidateRoots, rankSandboxes } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

function memFs(files) {
  const texts = new Map(Object.entries(files).map(([p, t]) => [path.resolve(p), t]));
  const folders = new Set();
  for (const p of texts.keys()) {
    for (let d = path.dirname(p); !folders.has(d); d = path.dirname(d)) {
      folders.add(d);
      if (path.dirname(d) === d) break;
    }
  }
  return {
    readFile: (p) => texts.get(path.resolve(p)),
    listFiles: (d) => [...texts.keys()].filter((p) => path.dirname(p) === path.resolve(d)).map((p) => path.basename(p)),
    listDirs: (d) => [...folders].filter((f) => f !== path.resolve(d) && path.dirname(f) === path.resolve(d)),
  };
}

function step(id, action, file, symbol = "") {
  return { id, title: id, phase: "Phase 1", file, action, symbol, why: "", retro: { question: "", invariants: [] }, line: 1, red: [], green: [] };
}

const BASE = "fn foo() -> u32 {\n    1\n}\n";

// The agent's sandbox is not among the candidates (moved, deleted, under a
// folder the probe does not walk). A stale copy of the target at the base
// commit sits beside it. Its bytes for every modify step equal the target's,
// so it proves nothing, yet it resolves every step.
test("a base-state copy of the target is never the unique pick for a modify-only guide", () => {
  const fsx = memFs({
    "/w/target/src/lib.rs": BASE,
    "/w/target-old/src/lib.rs": BASE,
    "/w/sessions/s1/replay-guide.md": "x",
  });
  const candidates = candidateRoots(
    { sessionDir: "/w/sessions/s1", workspaceRoot: "/w/target", stopAt: "/", extra: [] },
    fsx,
  );
  const v = rankSandboxes([step("1.1", "modify", "src/lib.rs", "foo")], candidates, fsx);
  assert.notStrictEqual(v.kind, "unique", `picked ${v.pick && v.pick.root} with no byte that differs from the target`);
});

test("a base-state copy of the target is never the unique pick for a patch-only guide", () => {
  const fsx = memFs({ "/w/target/Cargo.toml": "[package]\n", "/w/target-old/Cargo.toml": "[package]\n" });
  const v = rankSandboxes([step("1.1", "patch", "Cargo.toml")], ["/w/target-old"], fsx);
  assert.notStrictEqual(v.kind, "unique", `picked ${v.pick && v.pick.root} on file existence alone`);
});

// Deletes are not scored, so a tree that still holds the item the guide
// deletes scores the same as the finished sandbox.
test("a tree still holding the deleted item is not proven by a modify+delete guide", () => {
  const fsx = memFs({ "/w/snapshot/src/lib.rs": BASE + "\nfn gone() {}\n" });
  const steps = [step("1.1", "modify", "src/lib.rs", "foo"), step("1.2", "delete", "src/lib.rs", "gone")];
  const v = rankSandboxes(steps, ["/w/snapshot"], fsx);
  assert.notStrictEqual(v.kind, "unique", "the sandbox lost `gone`; this tree still has it");
});

// Behaviour 5: a plain sandbox keeps today's behaviour. A repo that ships a
// top-level replay-guide.md (this repo's own shape, or any sandbox of a repo
// that commits its guide at the root) is now routed into the session flow,
// and the session folder itself is never a candidate, so the tree that holds
// the code is never probed.
test("a sandbox with a top-level replay-guide.md is still probed as its own sandbox", () => {
  const fsx = memFs({
    "/home/u/sandbox/box/replay-guide.md": "x",
    "/home/u/sandbox/box/src/lib.rs": "fn bar() {}\n",
    "/home/u/work/target/src/lib.rs": BASE,
  });
  assert.ok(sessionGuides("/home/u/sandbox/box", fsx).length > 0, "extension takes the session branch");
  const candidates = candidateRoots(
    { sessionDir: "/home/u/sandbox/box", workspaceRoot: "/home/u/work/target", stopAt: "/home/u", sandboxParent: "/home/u/sandbox", extra: [] },
    fsx,
  );
  const v = rankSandboxes([step("1.1", "create", "src/lib.rs", "bar")], candidates, fsx);
  assert.strictEqual(v.kind, "unique", `verdict ${v.kind}; candidates ${JSON.stringify(candidates)}`);
  assert.strictEqual(v.pick.root, "/home/u/sandbox/box");
});
