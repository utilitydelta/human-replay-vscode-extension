// Unit tests for the insert walk's re-anchored recovery primitive
// (src/disclosure/anchoredInsert.ts), driven by the real walk plan (walk.ts).
//
// The happy-path walk stays on baked offsets; this is the path that takes over once
// the human authors their own code mid-build. The invariants (S11, now over the
// shipped modules): replaying the plan via parent-anchored appends reproduces the
// symbol; an additive edit is preserved with the remaining nodes still landing in
// order; a missing parent returns null (the collision signal).
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".anchored.bundle.cjs");
const entry = path.join(__dirname, ".anchored.entry.ts");
fs.writeFileSync(
  entry,
  `export { computeSteps } from "../src/disclosure/walk";\n` +
    `export { appendEdit, applyAppend, innermostContainerKey } from "../src/disclosure/anchoredInsert";\n` +
    `export { parseRoot } from "../src/disclosure/diff";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { computeSteps, appendEdit, applyAppend, innermostContainerKey, parseRoot } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const named = (n) => {
  const out = [];
  for (let i = 0; i < n.namedChildCount; i++) out.push(n.namedChild(i));
  return out;
};
const unwrap = (n) => (n.type === "expression_statement" && n.namedChildCount === 1 ? n.namedChild(0) : n);
const findFn = (n) => {
  if (n.type === "function_item") return n;
  for (const c of named(n)) {
    const f = findFn(c);
    if (f) return f;
  }
  return null;
};
const sliceOf = (n, src) => src.slice(n.startIndex, n.endIndex);
// Structural signature: nesting + leaf text, whitespace-insensitive.
function sig(node, src) {
  const kids = named(node).map(unwrap);
  if (kids.length === 0) return `${node.type}(${JSON.stringify(sliceOf(node, src).trim())})`;
  return `${node.type}{${kids.map((k) => sig(k, src)).join(",")}}`;
}
const fnSig = (src) => sig(findFn(parseRoot(src)), src);
const clean = (src) => {
  const s = parseRoot(src).toString();
  return !s.includes("ERROR") && !s.includes("MISSING");
};

// Replay a plan via parent-anchored appends; the first ROOT step seeds the buffer.
function build(steps, inject) {
  let buf = "";
  for (let i = 0; i < steps.length; i++) {
    if (inject && inject.before === i) {
      const e = appendEdit(buf, inject.parent, inject.text);
      if (!e) return null;
      buf = applyAppend(buf, e);
    }
    const s = steps[i];
    if (s.parentKey === "ROOT" && buf === "") {
      buf = s.bareText;
      continue;
    }
    const e = appendEdit(buf, s.parentKey, s.bareText);
    if (!e) return null;
    buf = applyAppend(buf, e);
  }
  return buf;
}

const CORPUS = [
  {
    name: "must_fence (for/if/return)",
    src: `fn must_fence(&self, now: Timestamp) -> bool {\n    for peer in &self.peers {\n        if peer.lease_expiry < now {\n            return true;\n        }\n    }\n    false\n}`,
  },
  {
    name: "active_leaders (let/for/if/count)",
    src: `fn active_leaders(peers: &[(u32, u64)], now: u64) -> usize {\n    let mut count = 0;\n    for peer in peers {\n        if !expired(peer, now) {\n            count += 1;\n        }\n    }\n    count\n}`,
  },
];

for (const c of CORPUS) {
  test(`${c.name}: re-anchored replay reproduces the symbol byte-exact`, () => {
    const built = build(computeSteps(c.src));
    assert.ok(built !== null, "build completes");
    assert.ok(clean(built), "parses clean");
    // Byte-exact, not just structural — this locks the per-line indentation of
    // appended container shells (the bug the structural sig missed).
    assert.strictEqual(built, c.src);
  });

  test(`${c.name}: every planned leaf text lands`, () => {
    const steps = computeSteps(c.src);
    const built = build(steps);
    for (const s of steps.filter((s) => s.kind === "leaf")) {
      assert.ok(built.includes(s.bareText), `leaf ${JSON.stringify(s.bareText)} present`);
    }
  });
}

test("additive edit in the fn body survives; remaining planned nodes still land", () => {
  const src = CORPUS[0].src;
  const steps = computeSteps(src);
  // inject a user line into the fn body right before the trailing `false` lands
  const falseIdx = steps.length - 1;
  const built = build(steps, {
    before: falseIdx,
    parent: "fn must_fence(&self, now: Timestamp) -> bool",
    text: "let trace = 1;",
  });
  assert.ok(built !== null && clean(built), "build completes and parses clean");
  assert.ok(built.includes("let trace = 1;"), "user line survived");
  assert.ok(built.includes("return true;"), "planned nested node intact");
  const body = findFn(parseRoot(built)).childForFieldName("body");
  const kinds = named(body).map((c) => unwrap(c).type);
  assert.strictEqual(kinds[0], "for_expression", "for loop first");
  assert.ok(kinds.includes("let_declaration"), "user let present");
  assert.strictEqual(kinds[kinds.length - 1], "boolean_literal", "trailing false last");
});

// The recovery ghost inserts the next node at the CURSOR. That is only correct when
// the cursor sits in the node's own parent container. `innermostContainerKey` is the
// guard the controller uses to decline a cursor-insert when the walk is climbing back
// out to an ancestor — the bug where a function's tail `count` landed inside the inner
// `if` because the cursor was still nested there after `count += 1;`.
const DIVERGED_BUF = [
  "fn active_leaders(peers: &[(u32, u64)], now: u64, grace: u64) -> usize {",
  "    let mut count = 0;",
  '    info!("kds");', // the human's divergence
  "    for &(_id, expiry) in peers {",
  "        if !lease_expired(expiry, now, grace) {",
  "            count += 1;",
  "        }",
  "    }",
  "}",
].join("\n");
const keyAfter = (needle) => innermostContainerKey(DIVERGED_BUF, DIVERGED_BUF.indexOf(needle) + needle.length);
const FN_KEY = "fn active_leaders(peers: &[(u32, u64)], now: u64, grace: u64) -> usize";
const IF_KEY = "if !lease_expired(expiry, now, grace)";

test("innermostContainerKey reads the cursor's enclosing container (fn body vs a nested block)", () => {
  // After the human's own line and after the let — still directly in the fn body. The
  // key equals the fn header, which is exactly the parentKey the plan gives fn-body
  // nodes, so the controller's `key === step.parentKey` lets a cursor-insert proceed.
  assert.strictEqual(keyAfter('info!("kds");'), FN_KEY, "a sibling-to-be in the fn body anchors at the fn (cursor insert OK)");
  assert.strictEqual(keyAfter("let mut count = 0;"), FN_KEY);
  // After the deepest statement — the cursor is INSIDE the if, not the fn body.
  assert.strictEqual(keyAfter("count += 1;"), IF_KEY, "the cursor sits in the inner if — a fn-parented tail must NOT insert here");
});

test("climb-out: the tail expression placed structurally lands in the fn body, not the inner if", () => {
  // The tail `count` is parented at the fn (not a nested block); the controller declines
  // the cursor-insert (key mismatch above) and Tab routes to appendEdit by that parentKey.
  const tailStep = computeSteps(CORPUS[1].src).find((s) => s.kind === "leaf" && s.bareText === "count");
  assert.ok(tailStep && tailStep.parentKey.startsWith("fn active_leaders"), "the tail `count` is parented at the function, not a nested block");

  const e = appendEdit(DIVERGED_BUF, FN_KEY, "count");
  assert.ok(e, "the fn body is found by its header key");
  const built = applyAppend(DIVERGED_BUF, e);
  assert.ok(built.endsWith("    count\n}"), "the tail sits at the fn body end, body-indented, after the loop");

  const body = findFn(parseRoot(built)).childForFieldName("body");
  const kids = named(body).map(unwrap);
  assert.strictEqual(kids[kids.length - 1].type, "identifier", "the tail `count` is the LAST child of the fn body");
  assert.ok(kids.some((n) => n.type === "for_expression"), "the for loop is intact (the tail did not land inside it)");
});

test("collision: a missing parent returns null (surfaces, never guesses)", () => {
  const src = CORPUS[0].src;
  assert.strictEqual(appendEdit(src, "for nonexistent in nothing", "let x = 1;"), null);
});

test("baked-vs-recovery: with no divergence both yield the same structure", () => {
  // The happy path applies steps by baked offset; recovery replays by append. With
  // no divergence they must agree structurally (the recovery path is a safe takeover).
  for (const c of CORPUS) {
    assert.strictEqual(fnSig(build(computeSteps(c.src))), fnSig(c.src));
  }
});
