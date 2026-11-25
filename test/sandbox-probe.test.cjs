// Black-box oracle for the sandbox probe (src/disclosure/sandboxProbe.ts),
// written against session-v7/contract.md only.
//
// The invariant: the sandbox is chosen only from bytes that prove it. A
// candidate counts a step only when the step's After bytes resolve from it
// (the file reads; for a known language, the symbol extracts). Exactly one
// candidate proving every step is the only automatic pick; several or none
// proven means the human picks, never a guess. A tree that resolves every
// step is proven only by bytes the target lacks: a create whose bytes differ
// from the target's, or a delete the target still holds and the tree lacks.
// Modify and patch never witness: mid-replay a base copy differs from the
// target exactly where the human already typed.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
// The fake trees use POSIX paths on every OS: the module and the fake
// filesystem both run on path.posix, so Windows CI reads "/w/t" as written.
const nativePath = require("path");
const path = nativePath.posix;
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = nativePath.join(__dirname, ".sandbox-probe.bundle.cjs");
esbuild.buildSync({
  entryPoints: [nativePath.join(__dirname, "../src/disclosure/sandboxProbe.ts")],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  alias: { path: "path/posix" },
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { sessionGuides, candidateRoots, probeSandbox, rankSandboxes, witnessed } = require(bundle);
test.after(() => fs.rmSync(bundle, { force: true }));

// In-memory ProbeFs. Folders are every ancestor of a file, plus any listed in
// `dirs` (for empty folders). `links` maps a symlink folder to its real
// folder; when given, the fs carries realPath.
function memFs(files, dirs = [], links) {
  const texts = new Map(Object.entries(files).map(([p, t]) => [path.resolve(p), t]));
  const folders = new Set(dirs.map((d) => path.resolve(d)));
  for (const p of texts.keys()) {
    let d = path.dirname(p);
    while (!folders.has(d)) {
      folders.add(d);
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  const fsx = {
    readFile: (p) => texts.get(path.resolve(p)),
    listFiles: (d) => {
      const dir = path.resolve(d);
      return [...texts.keys()].filter((p) => path.dirname(p) === dir).map((p) => path.basename(p));
    },
    listDirs: (d) => {
      const dir = path.resolve(d);
      return [...folders].filter((f) => f !== dir && path.dirname(f) === dir);
    },
  };
  if (links) {
    fsx.realPath = (p) => {
      const abs = path.resolve(p);
      for (const [link, real] of Object.entries(links)) {
        if (abs === link) return real;
        if (abs.startsWith(link + "/")) return real + abs.slice(link.length);
      }
      return abs;
    };
  }
  return fsx;
}

function step(id, action, file, symbol = "", extra = {}) {
  return {
    id, title: `step ${id}`, phase: "Phase 1", file, action, symbol, why: "",
    retro: { question: "", invariants: [] }, line: 1, red: [], green: [], ...extra,
  };
}

const norm = (list) => list.map((p) => path.resolve(p));

// ---------------------------------------------------------------- sessionGuides

test("sessionGuides: replay-guide.md first, translated guides after", () => {
  const fsx = memFs({
    "/s/replay-guide.zh.md": "x",
    "/s/replay-guide.md": "x",
    "/s/replay-guide.de.md": "x",
  });
  assert.deepStrictEqual(sessionGuides("/s", fsx), [
    "/s/replay-guide.md", "/s/replay-guide.de.md", "/s/replay-guide.zh.md",
  ]);
});

test("sessionGuides: nested guides and unrelated markdown are not guides", () => {
  const fsx = memFs({
    "/s/replay-guide.md": "x",
    "/s/briefs/replay-guide.md": "x",
    "/s/notes.md": "x",
    "/s/goal.md": "x",
    "/s/my-replay-guide.md": "x",
    "/s/replay-guide.md.bak": "x",
  });
  assert.deepStrictEqual(sessionGuides("/s", fsx), ["/s/replay-guide.md"]);
});

test("sessionGuides: a translated guide alone still makes a session folder", () => {
  const fsx = memFs({ "/s/replay-guide.zh.md": "x" });
  assert.deepStrictEqual(sessionGuides("/s", fsx), ["/s/replay-guide.zh.md"]);
});

test("sessionGuides: an empty or guide-less folder is not a session folder", () => {
  assert.deepStrictEqual(sessionGuides("/empty", memFs({}, ["/empty"])), []);
  assert.deepStrictEqual(sessionGuides("/s", memFs({ "/s/briefs/replay-guide.md": "x" })), []);
  assert.deepStrictEqual(sessionGuides("/missing", memFs({})), []);
});

// --------------------------------------------------------------- candidateRoots

// The real layout: workspace /w/t/svc, session in /w/t/bots/sessions/v6, the
// lead worktree a sibling of the workspace, sandboxes under /sb.
const LAYOUT = memFs({}, [
  "/w/t/svc/src",
  "/w/t/svc/nested",
  "/w/t/bots/sessions/v6",
  "/w/t/lead",
  "/w/t/aaa",
  "/sb/one",
  "/sb/two",
]);

test("candidateRoots: sessionDir first, then ancestors nearest first, extra, siblings, sandboxParent children", () => {
  const got = candidateRoots({
    sessionDir: "/w/t/bots/sessions/v6",
    workspaceRoot: "/w/t/svc",
    stopAt: "/w",
    sandboxParent: "/sb",
    extra: ["/remembered/box"],
  }, LAYOUT);
  const r = norm(got);
  // The session folder itself comes first: a sandbox carrying its guide at
  // its root must be able to prove itself.
  assert.strictEqual(r[0], "/w/t/bots/sessions/v6");
  // stopAt and above never appear.
  assert.ok(!r.includes("/w") && !r.includes("/"));
  // The target and anything inside it never appear.
  assert.ok(!r.some((p) => p === "/w/t/svc" || p.startsWith("/w/t/svc/")));
  // Ancestors first, nearest first.
  assert.deepStrictEqual(r.slice(1, 4), ["/w/t/bots/sessions", "/w/t/bots", "/w/t"]);
  // Then extra.
  assert.strictEqual(r[4], "/remembered/box");
  // Then siblings of the workspace (bots already appeared as an ancestor).
  const siblings = r.slice(5, r.length - 2);
  assert.deepStrictEqual([...siblings].sort(), ["/w/t/aaa", "/w/t/lead"]);
  // Then sandboxParent children.
  assert.deepStrictEqual([...r.slice(-2)].sort(), ["/sb/one", "/sb/two"]);
  // No duplicates.
  assert.strictEqual(new Set(r).size, r.length);
});

test("candidateRoots: stopAt excludes itself and everything above it", () => {
  const r = norm(candidateRoots({
    sessionDir: "/w/t/bots/sessions/v6",
    workspaceRoot: "/w/t/svc",
    stopAt: "/w/t",
    extra: [],
  }, LAYOUT));
  assert.deepStrictEqual(r.slice(0, 3), ["/w/t/bots/sessions/v6", "/w/t/bots/sessions", "/w/t/bots"]);
  assert.ok(!r.includes("/w/t") && !r.includes("/w") && !r.includes("/"));
});

test("candidateRoots: no sandboxParent means no sandboxParent children", () => {
  const r = norm(candidateRoots({
    sessionDir: "/w/t/bots/sessions/v6",
    workspaceRoot: "/w/t/svc",
    stopAt: "/w",
    extra: [],
  }, LAYOUT));
  assert.ok(!r.some((p) => p.startsWith("/sb")));
});

test("candidateRoots: the target and folders inside it are dropped even from extra", () => {
  const r = norm(candidateRoots({
    sessionDir: "/w/t/bots/sessions/v6",
    workspaceRoot: "/w/t/svc",
    stopAt: "/w",
    extra: ["/w/t/svc", "/w/t/svc/", "/w/t/svc/nested", "/w/t/lead"],
  }, LAYOUT));
  assert.ok(!r.some((p) => p === "/w/t/svc" || p.startsWith("/w/t/svc/")));
  assert.ok(r.includes("/w/t/lead"));
});

test("candidateRoots: a session folder inside the target yields none of the target's folders, itself included", () => {
  const fsx = memFs({}, ["/w/t/svc/sessions/v1", "/w/t/lead"]);
  const r = norm(candidateRoots({
    sessionDir: "/w/t/svc/sessions/v1",
    workspaceRoot: "/w/t/svc",
    stopAt: "/w",
    extra: [],
  }, fsx));
  assert.ok(!r.some((p) => p === "/w/t/svc" || p.startsWith("/w/t/svc/")));
  assert.ok(r.includes("/w/t") && r.includes("/w/t/lead"));
  assert.ok(r.indexOf("/w/t") < r.indexOf("/w/t/lead"));
});

test("candidateRoots: dedupe keeps the first position, trailing slash irrelevant", () => {
  const r = norm(candidateRoots({
    sessionDir: "/w/t/bots/sessions/v6/",
    workspaceRoot: "/w/t/svc/",
    stopAt: "/w/",
    sandboxParent: "/sb/",
    extra: ["/w/t/lead/", "/w/t/bots/", "/sb/one", "/w/t/lead"],
  }, LAYOUT));
  assert.strictEqual(new Set(r).size, r.length);
  // bots stays at its ancestor slot, lead at its extra slot.
  assert.deepStrictEqual(r.slice(0, 5), ["/w/t/bots/sessions/v6", "/w/t/bots/sessions", "/w/t/bots", "/w/t", "/w/t/lead"]);
  assert.strictEqual(r[5], "/sb/one");
  assert.ok(!r.includes("/w/t/svc"));
});

test("candidateRoots: the target opened through a symlink is still excluded", () => {
  const fsx = memFs({}, ["/w/t/svc/src", "/w/t/lead", "/w/t/bots/sessions/v6", "/home/j"], {
    "/home/j/svc": "/w/t/svc",
    "/home/j/lead": "/w/t/lead",
  });
  const r = candidateRoots({
    sessionDir: "/w/t/bots/sessions/v6",
    workspaceRoot: "/home/j/svc",
    stopAt: "/w",
    extra: ["/home/j/svc", "/home/j/svc/src", "/home/j/lead"],
  }, fsx);
  // Real paths come back; nothing resolves to the target or inside it.
  assert.ok(!r.some((p) => p === "/w/t/svc" || p.startsWith("/w/t/svc/")));
  assert.ok(!r.some((p) => p.startsWith("/home/j/svc")));
  // The linked lead is returned by its real path, deduped against the sibling.
  assert.ok(!r.includes("/home/j/lead"));
  assert.strictEqual(r.filter((p) => p === "/w/t/lead").length, 1);
  // lead keeps its extra slot, right after the ancestors.
  assert.deepStrictEqual(r.slice(0, 5), ["/w/t/bots/sessions/v6", "/w/t/bots/sessions", "/w/t/bots", "/w/t", "/w/t/lead"]);
});

test("candidateRoots: sessionDir and stopAt resolve through realPath too", () => {
  const fsx = memFs({}, ["/w/t/svc", "/w/t/bots/sessions/v6", "/w/t/lead"], {
    "/s": "/w/t/bots/sessions/v6",
    "/top": "/w/t",
  });
  const r = candidateRoots({
    sessionDir: "/s",
    workspaceRoot: "/w/t/svc",
    stopAt: "/top",
    extra: ["/w/t/bots/sessions/v6/"],
  }, fsx);
  assert.deepStrictEqual(r.slice(0, 3), ["/w/t/bots/sessions/v6", "/w/t/bots/sessions", "/w/t/bots"]);
  assert.ok(!r.includes("/s") && !r.includes("/w/t") && !r.includes("/w"));
  assert.strictEqual(new Set(r).size, r.length);
  assert.ok(r.includes("/w/t/lead"));
});

// ----------------------------------------------------------------- probeSandbox

const RS_FOO = "fn foo() -> u32 {\n    1\n}\n";
const RS_FOO_BAR = "fn foo() -> u32 {\n    2\n}\n\nfn bar() {}\n";
const TS_GREET = "export function greet(name: string): string {\n  return name;\n}\n";

test("probeSandbox: a symbol step resolves only when the symbol extracts from the file", () => {
  const steps = [
    step("1.1", "modify", "src/lib.rs", "foo"),
    step("1.2", "create", "src/lib.rs", "bar"),
    step("1.3", "create", "src/app.ts", "greet"),
  ];
  const full = memFs({ "/box/src/lib.rs": RS_FOO_BAR, "/box/src/app.ts": TS_GREET });
  assert.deepStrictEqual(probeSandbox(steps, "/box", full), { root: "/box", resolved: 3, total: 3, missing: [] });

  // File present, symbol absent: the bytes don't prove it.
  const partial = memFs({ "/box/src/lib.rs": RS_FOO, "/box/src/app.ts": "export const x = 1;\n" });
  assert.deepStrictEqual(probeSandbox(steps, "/box", partial), {
    root: "/box", resolved: 1, total: 3, missing: ["1.2", "1.3"],
  });
});

test("probeSandbox: create-file and patch need only the file", () => {
  const steps = [
    step("1.1", "create-file", "src/new.rs"),
    step("1.2", "patch", "Cargo.toml"),
  ];
  const fsx = memFs({ "/box/src/new.rs": "not even rust {{{", "/box/Cargo.toml": "[package]\n" });
  assert.deepStrictEqual(probeSandbox(steps, "/box", fsx), { root: "/box", resolved: 2, total: 2, missing: [] });
  assert.deepStrictEqual(probeSandbox(steps, "/other", fsx), {
    root: "/other", resolved: 0, total: 2, missing: ["1.1", "1.2"],
  });
});

test("probeSandbox: a file:line suffix is stripped before reading", () => {
  const steps = [
    step("1.1", "modify", "src/lib.rs:12", "foo"),
    step("1.2", "patch", "Cargo.toml:3"),
    step("1.3", "create-file", "src/new.rs:1"),
  ];
  const fsx = memFs({ "/box/src/lib.rs": RS_FOO, "/box/Cargo.toml": "[a]\n", "/box/src/new.rs": "x" });
  assert.deepStrictEqual(probeSandbox(steps, "/box", fsx), { root: "/box", resolved: 3, total: 3, missing: [] });
});

test("probeSandbox: deletes, fenced-after steps, and pause steps are not sandbox-sourced", () => {
  const steps = [
    step("1.1", "delete", "src/gone.rs", "old"),
    step("1.2", "modify", "src/lib.rs", "foo", { before: "fn foo() {}", after: "fn foo() -> u32 { 1 }" }),
    step("1.3", "create", "src/lib.rs", "baz", { after: "fn baz() {}" }),
    step("1.4", "create-file", "src/fenced.rs", "", { after: "fn f() {}\n" }),
    step("1.5", "read", "src/lib.rs"),
    step("1.6", "comment", "src/lib.rs"),
    step("1.7", "rule", "src/lib.rs"),
    step("1.8", "modify", "src/lib.rs", "foo"),
  ];
  const fsx = memFs({ "/box/src/lib.rs": RS_FOO });
  assert.deepStrictEqual(probeSandbox(steps, "/box", fsx), { root: "/box", resolved: 1, total: 1, missing: [] });
  assert.deepStrictEqual(probeSandbox(steps, "/nowhere", fsx), {
    root: "/nowhere", resolved: 0, total: 1, missing: ["1.8"],
  });
});

test("probeSandbox: a file in no known language counts on existence alone", () => {
  const steps = [step("1.1", "create", "config/settings.toml", "no_such_symbol")];
  const fsx = memFs({ "/box/config/settings.toml": "key = 1\n" });
  assert.deepStrictEqual(probeSandbox(steps, "/box", fsx), { root: "/box", resolved: 1, total: 1, missing: [] });
  assert.deepStrictEqual(probeSandbox(steps, "/empty", fsx), {
    root: "/empty", resolved: 0, total: 1, missing: ["1.1"],
  });
});

test("probeSandbox: missing ids come back in guide order, not file or resolve order", () => {
  const steps = [
    step("2.3", "modify", "src/z.rs", "zed"),
    step("1.1", "create", "src/a.rs", "alpha"),
    step("1.9", "create-file", "src/b.rs"),
    step("1.2", "modify", "src/a.rs", "foo"),
  ];
  const fsx = memFs({ "/box/src/a.rs": RS_FOO });
  assert.deepStrictEqual(probeSandbox(steps, "/box", fsx), {
    root: "/box", resolved: 1, total: 4, missing: ["2.3", "1.1", "1.9"],
  });
});

// ---------------------------------------------------------------- rankSandboxes

test("rankSandboxes: a guide with no sandbox-sourced steps needs no sandbox", () => {
  const steps = [
    step("1.1", "modify", "src/lib.rs", "foo", { before: "a", after: "b" }),
    step("1.2", "delete", "src/lib.rs", "old"),
    step("1.3", "read", "src/lib.rs"),
  ];
  const fsx = memFs({ "/box/src/lib.rs": RS_FOO });
  assert.deepStrictEqual(rankSandboxes(steps, ["/box"], fsx), { kind: "not-needed" });
  assert.deepStrictEqual(rankSandboxes([], ["/box"], fsx), { kind: "not-needed" });
});

// The realistic case: a stale copy of the target resolves the modify steps
// (the symbols already exist there) but not the new creates; the lead
// worktree resolves them all.
const REAL_STEPS = [
  step("1.1", "modify", "src/lib.rs", "foo"),
  step("1.2", "create", "src/lib.rs", "bar"),
  step("1.3", "create-file", "src/dst.rs"),
];
const REAL_FS = memFs({
  "/w/copy/src/lib.rs": RS_FOO,
  "/w/lead/src/lib.rs": RS_FOO_BAR,
  "/w/lead/src/dst.rs": "fn dst() {}\n",
  "/w/unrelated/README.md": "# hi\n",
});

test("rankSandboxes: exactly one candidate resolving every step is the pick", () => {
  const v = rankSandboxes(REAL_STEPS, ["/w/unrelated", "/w/copy", "/w/lead"], REAL_FS);
  assert.strictEqual(v.kind, "unique");
  assert.deepStrictEqual(v.pick, { root: "/w/lead", resolved: 3, total: 3, missing: [] });
  assert.deepStrictEqual(v.ranked, [
    { root: "/w/lead", resolved: 3, total: 3, missing: [] },
    { root: "/w/copy", resolved: 1, total: 3, missing: ["1.2", "1.3"] },
  ]);
  assert.strictEqual(v.pick, v.ranked[0]);
});

test("rankSandboxes: two candidates resolving every step is ambiguous, never a guess", () => {
  const fsx = memFs({
    "/a/src/lib.rs": RS_FOO_BAR, "/a/src/dst.rs": "x",
    "/b/src/lib.rs": RS_FOO_BAR, "/b/src/dst.rs": "y",
    "/c/src/lib.rs": RS_FOO,
  });
  const v = rankSandboxes(REAL_STEPS, ["/c", "/b", "/a"], fsx);
  assert.strictEqual(v.kind, "ambiguous");
  assert.strictEqual(v.pick, undefined);
  // Ties keep candidate order: /b was offered before /a.
  assert.deepStrictEqual(v.ranked.map((r) => [r.root, r.resolved]), [["/b", 3], ["/a", 3], ["/c", 1]]);
});

test("rankSandboxes: no candidate resolving every step is none, with partial scores ranked", () => {
  const fsx = memFs({
    "/p/src/lib.rs": RS_FOO,
    "/q/src/lib.rs": RS_FOO_BAR,
    "/r/src/dst.rs": "x",
  });
  const v = rankSandboxes(REAL_STEPS, ["/p", "/zero", "/r", "/q"], fsx);
  assert.strictEqual(v.kind, "none");
  assert.strictEqual(v.pick, undefined);
  // resolved 0 is dropped; ties (/p and /r at 1) keep candidate order.
  assert.deepStrictEqual(v.ranked.map((r) => [r.root, r.resolved]), [["/q", 2], ["/p", 1], ["/r", 1]]);
  assert.deepStrictEqual(v.ranked[0].missing, ["1.3"]);
});

test("rankSandboxes: nothing resolving anything is none with an empty ranking", () => {
  const v = rankSandboxes(REAL_STEPS, ["/w/unrelated", "/nope"], REAL_FS);
  assert.deepStrictEqual(v, { kind: "none", ranked: [] });
  assert.deepStrictEqual(rankSandboxes(REAL_STEPS, [], REAL_FS), { kind: "none", ranked: [] });
});

// ------------------------------------------------- rankSandboxes: target witness

// The target (workspaceRoot) is /t. A candidate that resolves every step is
// proven only by a create or delete witness against the target.
const RS_FOO_V1 = "fn foo() -> u32 {\n    1\n}\n";
const RS_FOO_V2 = "fn foo() -> u32 {\n    2\n}\n";
const MODIFY_ONLY = [step("1.1", "modify", "src/lib.rs", "foo")];

test("rankSandboxes: a base copy identical to the target resolves everything yet proves nothing", () => {
  const fsx = memFs({ "/t/src/lib.rs": RS_FOO_V1, "/copy/src/lib.rs": RS_FOO_V1 });
  const v = rankSandboxes(MODIFY_ONLY, ["/copy"], fsx, "/t");
  assert.strictEqual(v.kind, "unproven");
  assert.strictEqual(v.pick, undefined);
  assert.deepStrictEqual(v.ranked, [{ root: "/copy", resolved: 1, total: 1, missing: [] }]);
});

test("rankSandboxes: modify bytes that differ from the target never witness", () => {
  const fsx = memFs({
    "/t/src/lib.rs": RS_FOO_V1,
    "/copy/src/lib.rs": RS_FOO_V1,
    "/lead/src/lib.rs": RS_FOO_V2,
  });
  const v = rankSandboxes(MODIFY_ONLY, ["/copy", "/lead"], fsx, "/t");
  assert.strictEqual(v.kind, "unproven");
  assert.strictEqual(v.pick, undefined);
  // Both resolve 1: ties in candidate order.
  assert.deepStrictEqual(v.ranked.map((r) => r.root), ["/copy", "/lead"]);
});

test("rankSandboxes: mid-replay, a base copy differing where the human landed a step is not unique", () => {
  // Guide modifies foo (1.1) and baz (1.2). The human has landed 1.1, so the
  // target's foo is the sandbox's. The base copy still holds the old foo: it
  // differs from the target on 1.1 only because the human typed it.
  const steps = [step("1.1", "modify", "src/lib.rs", "foo"), step("1.2", "modify", "src/lib.rs", "baz")];
  const BAZ_OLD = "\nfn baz() {}\n";
  const BAZ_NEW = "\nfn baz() { foo(); }\n";
  const fsx = memFs({
    "/t/src/lib.rs": RS_FOO_V2 + BAZ_OLD,
    "/base/src/lib.rs": RS_FOO_V1 + BAZ_OLD,
    "/lead/src/lib.rs": RS_FOO_V2 + BAZ_NEW,
  });
  const alone = rankSandboxes(steps, ["/base"], fsx, "/t");
  assert.notStrictEqual(alone.kind, "unique");
  assert.strictEqual(alone.kind, "unproven");
  const both = rankSandboxes(steps, ["/base", "/lead"], fsx, "/t");
  assert.strictEqual(both.kind, "unproven");
  assert.deepStrictEqual(both.ranked.map((r) => r.root), ["/base", "/lead"]);
});

test("rankSandboxes: symbol creates compare the named item, not the whole file", () => {
  // The target already holds bar; the candidate's bar is identical but its
  // file carries an unrelated extra item: no witness.
  const steps = [step("1.1", "create", "src/lib.rs", "bar")];
  const fsx = memFs({
    "/t/src/lib.rs": RS_FOO_V1 + "\nfn bar() {}\n",
    "/c/src/lib.rs": "fn bar() {}\n\nfn unrelated() {}\n",
  });
  assert.strictEqual(rankSandboxes(steps, ["/c"], fsx, "/t").kind, "unproven");
});

test("rankSandboxes: a modify whose target file is missing witnesses nothing", () => {
  const fsx = memFs({ "/lead/src/lib.rs": RS_FOO_V2 }, ["/t"]);
  assert.strictEqual(rankSandboxes(MODIFY_ONLY, ["/lead"], fsx, "/t").kind, "unproven");
});

test("rankSandboxes: a patch never witnesses, differing or not", () => {
  const steps = [step("1.1", "patch", "Cargo.toml")];
  const same = memFs({ "/t/Cargo.toml": "[a]\n", "/c/Cargo.toml": "[a]\n" });
  assert.strictEqual(rankSandboxes(steps, ["/c"], same, "/t").kind, "unproven");
  const differ = memFs({ "/t/Cargo.toml": "[a]\n", "/c/Cargo.toml": "[a]\nb = 1\n" });
  assert.strictEqual(rankSandboxes(steps, ["/c"], differ, "/t").kind, "unproven");
  const noTarget = memFs({ "/c/Cargo.toml": "[a]\n" }, ["/t"]);
  assert.strictEqual(rankSandboxes(steps, ["/c"], noTarget, "/t").kind, "unproven");
});

test("rankSandboxes: a create the target already holds byte-identical is no witness", () => {
  const steps = [step("1.1", "create", "src/lib.rs", "bar")];
  const BAR = "fn bar() {}\n";
  const landed = memFs({ "/t/src/lib.rs": RS_FOO_V1 + "\n" + BAR, "/c/src/lib.rs": BAR });
  assert.strictEqual(rankSandboxes(steps, ["/c"], landed, "/t").kind, "unproven");
  // Target lacks the item: the create witnesses.
  const fresh = memFs({ "/t/src/lib.rs": RS_FOO_V1, "/c/src/lib.rs": BAR });
  assert.strictEqual(rankSandboxes(steps, ["/c"], fresh, "/t").kind, "unique");
});

test("rankSandboxes: create-file witnesses when the target file is missing or differs, not when identical", () => {
  const steps = [step("1.1", "create-file", "src/dst.rs")];
  const missing = memFs({ "/c/src/dst.rs": "fn dst() {}\n" }, ["/t"]);
  assert.strictEqual(rankSandboxes(steps, ["/c"], missing, "/t").kind, "unique");
  const differ = memFs({ "/t/src/dst.rs": "// stub\n", "/c/src/dst.rs": "fn dst() {}\n" });
  assert.strictEqual(rankSandboxes(steps, ["/c"], differ, "/t").kind, "unique");
  const same = memFs({ "/t/src/dst.rs": "fn dst() {}\n", "/c/src/dst.rs": "fn dst() {}\n" });
  assert.strictEqual(rankSandboxes(steps, ["/c"], same, "/t").kind, "unproven");
});

test("rankSandboxes: a delete witnesses when the target holds the item and the candidate does not", () => {
  const steps = [...MODIFY_ONLY, step("1.2", "delete", "src/lib.rs", "old")];
  const OLD = "\nfn old() {}\n";
  const struck = memFs({ "/t/src/lib.rs": RS_FOO_V1 + OLD, "/c/src/lib.rs": RS_FOO_V1 });
  const v = rankSandboxes(steps, ["/c"], struck, "/t");
  assert.strictEqual(v.kind, "unique");
  // The delete never counts in total.
  assert.deepStrictEqual(v.pick, { root: "/c", resolved: 1, total: 1, missing: [] });
  // Target already lost the item: no witness.
  const gone = memFs({ "/t/src/lib.rs": RS_FOO_V1, "/c/src/lib.rs": RS_FOO_V1 });
  assert.strictEqual(rankSandboxes(steps, ["/c"], gone, "/t").kind, "unproven");
  // Candidate still holds it: no witness, and still no disqualification.
  const kept = memFs({ "/t/src/lib.rs": RS_FOO_V1 + OLD, "/c/src/lib.rs": RS_FOO_V1 + OLD });
  const k = rankSandboxes(steps, ["/c"], kept, "/t");
  assert.strictEqual(k.kind, "unproven");
  assert.deepStrictEqual(k.ranked, [{ root: "/c", resolved: 1, total: 1, missing: [] }]);
});

test("rankSandboxes: a delete in no known language witnesses nothing", () => {
  const steps = [step("1.1", "patch", "Cargo.toml"), step("1.2", "delete", "conf/x.toml", "old")];
  const fsx = memFs({
    "/t/Cargo.toml": "[a]\n", "/t/conf/x.toml": "old = 1\n",
    "/c/Cargo.toml": "[a]\n",
  });
  assert.strictEqual(rankSandboxes(steps, ["/c"], fsx, "/t").kind, "unproven");
});

test("rankSandboxes: with no workspaceRoot, modify proves nothing and create proves", () => {
  const modFs = memFs({ "/lead/src/lib.rs": RS_FOO_V2 });
  assert.strictEqual(rankSandboxes(MODIFY_ONLY, ["/lead"], modFs).kind, "unproven");
  const patchOnly = [step("1.1", "patch", "Cargo.toml")];
  assert.strictEqual(rankSandboxes(patchOnly, ["/c"], memFs({ "/c/Cargo.toml": "x" })).kind, "unproven");
  const createFs = memFs({ "/lead/src/lib.rs": "fn bar() {}\n", "/lead/src/n.rs": "x" });
  assert.strictEqual(rankSandboxes([step("1.1", "create", "src/lib.rs", "bar")], ["/lead"], createFs).kind, "unique");
  assert.strictEqual(rankSandboxes([step("1.1", "create-file", "src/n.rs")], ["/lead"], createFs).kind, "unique");
});

test("rankSandboxes: two proven candidates are ambiguous even beside an unproven one", () => {
  const steps = [...MODIFY_ONLY, step("1.2", "create-file", "src/dst.rs")];
  const fsx = memFs({
    "/t/src/lib.rs": RS_FOO_V1, "/t/src/dst.rs": "x",
    "/copy/src/lib.rs": RS_FOO_V1, "/copy/src/dst.rs": "x",
    "/a/src/lib.rs": RS_FOO_V2, "/a/src/dst.rs": "fn dst() {}\n",
    "/b/src/lib.rs": RS_FOO_V2, "/b/src/dst.rs": "fn dst() {}\n",
  });
  const v = rankSandboxes(steps, ["/copy", "/a", "/b"], fsx, "/t");
  assert.strictEqual(v.kind, "ambiguous");
  assert.deepStrictEqual(v.ranked.map((r) => r.root), ["/copy", "/a", "/b"]);
});

test("rankSandboxes: unproven needs a full resolve; partial resolves alone are none", () => {
  const steps = [...MODIFY_ONLY, step("1.2", "create-file", "src/dst.rs")];
  // Full resolve, but every byte matches the target: unproven.
  const full = memFs({
    "/t/src/lib.rs": RS_FOO_V1, "/t/src/dst.rs": "x",
    "/copy/src/lib.rs": RS_FOO_V1, "/copy/src/dst.rs": "x",
  });
  const u = rankSandboxes(steps, ["/copy"], full, "/t");
  assert.strictEqual(u.kind, "unproven");
  assert.strictEqual(u.ranked.length, 1);
  // Only partial resolves, even ones with differing bytes: none.
  const partial = memFs({ "/t/src/lib.rs": RS_FOO_V1, "/half/src/lib.rs": RS_FOO_V2 });
  const n = rankSandboxes(steps, ["/half"], partial, "/t");
  assert.strictEqual(n.kind, "none");
  assert.deepStrictEqual(n.ranked, [{ root: "/half", resolved: 1, total: 2, missing: ["1.2"] }]);
});

// ---------------------------------------------------------------- witnessed

test("witnessed: only creates the target lacks and deletes it still holds prove a tree", () => {
  const BAR = "fn bar() {}\n";
  const OLD = "\nfn old() {}\n";
  const fsx = memFs({
    "/t/src/lib.rs": RS_FOO_V1 + OLD,
    "/t/Cargo.toml": "[a]\n",
    "/base/src/lib.rs": RS_FOO_V1 + OLD,
    "/base/Cargo.toml": "[a]\n",
    "/edit/src/lib.rs": RS_FOO_V2 + OLD,
    "/edit/Cargo.toml": "[a]\nb = 1\n",
    "/new/src/lib.rs": RS_FOO_V1 + OLD + "\n" + BAR,
    "/new/src/dst.rs": "fn dst() {}\n",
    "/struck/src/lib.rs": RS_FOO_V1,
  });
  // Modify and patch: never, differing or not.
  const editSteps = [...MODIFY_ONLY, step("1.2", "patch", "Cargo.toml")];
  assert.strictEqual(witnessed(editSteps, "/base", fsx, "/t"), false);
  assert.strictEqual(witnessed(editSteps, "/edit", fsx, "/t"), false);
  // Create the target lacks: proves.
  assert.strictEqual(witnessed([step("1.1", "create", "src/lib.rs", "bar")], "/new", fsx, "/t"), true);
  // Create-file the target lacks: proves.
  assert.strictEqual(witnessed([step("1.1", "create-file", "src/dst.rs")], "/new", fsx, "/t"), true);
  // Create the target already holds identically: no.
  assert.strictEqual(witnessed([step("1.1", "create", "src/lib.rs", "foo")], "/base", fsx, "/t"), false);
  // Delete the target holds and the tree lacks: proves; the tree still holding it: no.
  const del = [step("1.1", "delete", "src/lib.rs", "old")];
  assert.strictEqual(witnessed(del, "/struck", fsx, "/t"), true);
  assert.strictEqual(witnessed(del, "/base", fsx, "/t"), false);
});

test("witnessed: with no workspaceRoot a create proves and a modify does not", () => {
  const fsx = memFs({ "/lead/src/lib.rs": RS_FOO_V2 + "\nfn bar() {}\n" });
  assert.strictEqual(witnessed(MODIFY_ONLY, "/lead", fsx), false);
  assert.strictEqual(witnessed([step("1.1", "create", "src/lib.rs", "bar")], "/lead", fsx), true);
});

test("witnessed: a guide with no steps proves nothing", () => {
  assert.strictEqual(witnessed([], "/lead", memFs({ "/lead/a.rs": "x" }), "/t"), false);
});
