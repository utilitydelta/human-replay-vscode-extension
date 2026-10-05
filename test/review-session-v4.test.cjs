// Adversarial review of the session-v4 change set, kept as regression oracles.
// Each test names the claim it checks. Tests marked "DEFECT" name a defect the
// review found; each one failed before its fix and must stay green.
//
// Run: node --test test/review-session-v4.test.cjs

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const EXTERNALS = ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"];
const entry = path.join(__dirname, ".review-session-v4.entry.ts");
const bundle = path.join(__dirname, ".review-session-v4.bundle.cjs");
fs.writeFileSync(
  entry,
  `export { planFileWalk, resumeWalk, landedWithAdditions, splitTrailing, leadPlan } from "../src/disclosure/fileWalk";\n` +
    `export { splitLeadingPad } from "../src/disclosure/insertion";\n` +
    `export { walkableSource, computeSteps } from "../src/disclosure/walk";\n` +
    `export { foreignSpans, transformRange, shiftAnchor, classifyWalkChanges } from "../src/disclosure/ledger";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n` +
    `export { resolveStep } from "../src/disclosure/replay";\n` +
    `export { blankLineDelta, lineDiffSteps } from "../src/disclosure/lineDiff";\n` +
    `export { parseRoot } from "../src/disclosure/diff";\n` +
    `export { stepAlreadyLanded } from "../src/disclosure/resume";\n` +
    `export { RUST, CSHARP, TYPESCRIPT, TSX, PYTHON, MARKDOWN, HTML, CSS } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({ entryPoints: [entry], bundle: true, outfile: bundle, format: "cjs", platform: "node", external: EXTERNALS });
const m = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});
const { planFileWalk, resumeWalk, landedWithAdditions, splitTrailing, splitLeadingPad, walkableSource } = m;

const read = (rel) => fs.readFileSync(path.join(__dirname, "corpus", rel), "utf8");
const prefix = (segs, k) => segs.slice(0, k).map((s) => s.sep + s.body).join("");

// What runNextSegment types BEFORE the walk's first accept (guideRunner.ts):
// lead + tail for a walkable segment, lead alone otherwise.
function preTyped(seg, spec) {
  const { pad, rest } = splitLeadingPad(seg.body);
  const { content, tail } = splitTrailing(rest);
  const walkable = content !== "" && walkableSource(content, spec);
  return { walkable, pad, rest, content, tail };
}

// Simulate runNextSegment from a resume point to the end of the file, with
// every walk / block ghost landing its sandbox bytes byte-exact. The lead is
// the runtime's own decision (leadPlan): typed at EOF, cursor parked
// cursorBack bytes before the new end, the engine lands at the cursor.
function finishFrom(buffer, segs, at, leadTyped, spec) {
  let buf = buffer;
  for (let k = at; k < segs.length; k++) {
    const seg = segs[k];
    const p = preTyped(seg, spec);
    const plan = m.leadPlan({ sep: seg.sep, pad: p.pad, tail: p.tail, walkable: p.walkable }, buf, k === at ? leadTyped : 0);
    buf = buf + plan.type;
    const cur = buf.length - plan.cursorBack;
    const landed = p.walkable ? p.content : p.rest;
    buf = buf.slice(0, cur) + landed + buf.slice(cur);
  }
  return buf;
}

const FILES = [
  { name: "rust incident sandbox", file: "field-rs-rearm-sandbox.rs", spec: () => m.RUST },
  { name: "rust matrix", file: "matrix/matrix-rust.rs", spec: () => m.RUST },
  { name: "python matrix", file: "matrix/matrix-python.py", spec: () => m.PYTHON },
  { name: "markdown matrix", file: "matrix/matrix-markdown.md", spec: () => m.MARKDOWN },
  { name: "typescript matrix", file: "matrix/matrix-typescript.ts.txt", spec: () => m.TYPESCRIPT },
];

// DEFECT 1: the re-arm click (runStepUnguarded on the in-flight step) BEFORE
// the walk's first accept. runNextSegment already typed lead + tail at EOF;
// the disclosure cancel leaves those bytes. resumeWalk counts the sep as typed
// but not the tail, so the re-run types the tail a second time.
for (const f of FILES) {
  test(`DEFECT re-arm at zero accepts (${f.name}): resume + finish reproduces the sandbox file`, () => {
    const spec = f.spec();
    const sandbox = read(f.file);
    const segs = planFileWalk(sandbox, spec);
    const bad = [];
    for (let k = 0; k < segs.length; k++) {
      const p = preTyped(segs[k], spec);
      if (!p.walkable) continue;
      const live = prefix(segs, k) + segs[k].sep + p.pad + p.tail; // what the buffer holds at the click
      const r = resumeWalk(segs, live, spec);
      if (!r) continue; // refusing is honest; only a wrong resume is a defect
      const out = finishFrom(live, segs, r.at, r.leadTyped, spec);
      if (out !== sandbox) bad.push(`segment ${k + 1}: resume at=${r.at} leadTyped=${r.leadTyped}; result ${out.length - sandbox.length} byte(s) off`);
    }
    assert.deepStrictEqual(bad, [], bad.join("\n"));
  });
}

// LIMIT (finding 5, deferred as documented): human code BELOW the walk
// frontier (after the last landed segment) refuses resume when the next
// segment rides the walk: it can't be told apart from a partial walk build.
test("LIMIT resumeWalk: a human helper fn below the frontier refuses when the next segment walks", () => {
  const sandbox = read("matrix/matrix-rust.rs");
  const segs = planFileWalk(sandbox, m.RUST);
  assert.ok(segs.length >= 3, "need at least three segments");
  const live = prefix(segs, 2) + "\n\nfn my_helper() {\n}\n";
  assert.strictEqual(resumeWalk(segs, live, m.RUST), undefined);
});

// The other side of the limit: human code BETWEEN landed segments resumes.
test("resumeWalk: a human helper fn between landed segments resumes at the frontier", () => {
  const sandbox = read("matrix/matrix-rust.rs");
  const segs = planFileWalk(sandbox, m.RUST);
  const helper = "fn my_helper() {\n    b();\n}\n\n";
  const p2 = prefix(segs, 2);
  const cut = p2.indexOf(segs[1].body);
  const live = p2.slice(0, cut) + helper + p2.slice(cut);
  const r = resumeWalk(segs, live, m.RUST);
  assert.ok(r && r.at === 2, `resume ${JSON.stringify(r)}`);
  const out = finishFrom(live, segs, r.at, r.leadTyped, m.RUST);
  assert.strictEqual(out.replace(helper, ""), sandbox);
});

// DEFECT 3 (pre-existing leg order, exposed by the new tolerance): the
// selfDelta leg ignores foreign edits and runs BEFORE ledgerRange. A human
// line whose length equals the distance between two equal originalText
// occurrences makes leg `a` byte-validate on the WRONG occurrence.
test("DEFECT resolveStep: a foreign line above a non-unique replace lands on the wrong occurrence", () => {
  const before = "fn f() {\n    g(alpha, alpha);\n}";
  const after = "fn f() {\n    g(alpha, omega);\n}";
  const steps = m.buildReplaySteps(before, after, m.RUST);
  const st = steps.find((s) => s.originalText === "alpha");
  assert.ok(st, `expected a replace of the second alpha; got ${JSON.stringify(steps.map((s) => [s.start, s.end, s.originalText, s.replacement]))}`);
  const dist = before.indexOf("alpha", before.indexOf("alpha") + 1) - before.indexOf("alpha"); // 7
  const lineStart = before.indexOf("    g(");
  const human = "//" + "x".repeat(dist - 3) + "\n"; // exactly `dist` bytes, a whole line
  assert.strictEqual(human.length, dist);
  const buf = before.slice(0, lineStart) + human + before.slice(lineStart);
  const ledger = [{ offset: lineStart, rangeLength: 0, textLength: human.length }];
  const r = m.resolveStep(buf, m.parseRoot(buf, m.RUST), st, 0, ledger);
  assert.ok(r, "resolved");
  const out = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
  assert.strictEqual(out.replace(human, ""), after, `wrong merge: ${JSON.stringify(out)}`);
});

// Evidence for a minor: landedWithAdditions marks a pre-existing foreign file
// landed as long as it line-contains the sandbox file. resumeWalk's doc says
// "a foreign file ... undefined"; the landed check never gets that far.
test("NOTE landedWithAdditions: a foreign file that line-contains a short sandbox file reads as landed", () => {
  const sandbox = "target/\n";
  const foreign = "# someone else's ignore file\nnode_modules/\ntarget/\n*.log\n";
  assert.strictEqual(landedWithAdditions(sandbox, foreign), true);
});

test("NOTE landedWithAdditions: a body line moved into a different fn still reads as landed", () => {
  const sandbox = "fn f() {\n    a();\n}\n";
  const target = "fn f() {\n}\nfn g() {\n    a();\n}\n";
  assert.strictEqual(landedWithAdditions(sandbox, target), true);
  assert.strictEqual(m.stepAlreadyLanded("create-file", target, sandbox), true);
});

// ---- property checks of the ledger arithmetic against a provenance model ----

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Buffer of tagged bytes: "s" sandbox/base, "h" human, "o" ours.
test("foreignSpans matches a byte-provenance model (or returns null)", () => {
  let checked = 0;
  for (let seed = 1; seed <= 4000; seed++) {
    const R = rng(seed);
    let tags = Array.from({ length: 40 }, () => "s");
    const ledger = [];
    const n = 1 + Math.floor(R() * 8);
    for (let i = 0; i < n; i++) {
      const self = R() < 0.4;
      const off = Math.floor(R() * (tags.length + 1));
      const kind = R();
      let len = 0;
      if (kind < 0.25) len = Math.min(tags.length - off, 1 + Math.floor(R() * 4));
      const text = kind < 0.85 ? 1 + Math.floor(R() * 5) : 0;
      if (len === 0 && text === 0) continue;
      tags = [...tags.slice(0, off), ...Array(text).fill(self ? "o" : "h"), ...tags.slice(off + len)];
      ledger.push({ offset: off, rangeLength: len, textLength: text, ...(self ? { self } : {}) });
    }
    const spans = m.foreignSpans(ledger);
    if (spans === null) continue;
    checked++;
    const mark = tags.map(() => false);
    for (const [s, e] of spans) for (let i = s; i < e; i++) mark[i] = true;
    for (let i = 0; i < tags.length; i++) {
      assert.strictEqual(mark[i], tags[i] === "h", `seed ${seed}: byte ${i} tag ${tags[i]} span ${mark[i]} spans=${JSON.stringify(spans)} ledger=${JSON.stringify(ledger)}`);
    }
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1], `seed ${seed}: overlapping spans`);
  }
  assert.ok(checked > 1000, `only ${checked} non-null cases`);
});

test("transformRange keeps the same bytes under the range (or returns null)", () => {
  let checked = 0;
  for (let seed = 1; seed <= 4000; seed++) {
    const R = rng(seed);
    let ids = Array.from({ length: 40 }, (_, i) => i);
    const s0 = Math.floor(R() * 35);
    const e0 = s0 + 1 + Math.floor(R() * 5);
    const ledger = [];
    let next = 1000;
    for (let i = 0, n = 1 + Math.floor(R() * 6); i < n; i++) {
      const off = Math.floor(R() * (ids.length + 1));
      const len = R() < 0.3 ? Math.min(ids.length - off, Math.floor(R() * 4)) : 0;
      const text = Math.floor(R() * 4);
      if (len === 0 && text === 0) continue;
      ids = [...ids.slice(0, off), ...Array.from({ length: text }, () => next++), ...ids.slice(off + len)];
      ledger.push({ offset: off, rangeLength: len, textLength: text, self: R() < 0.5 });
    }
    const t = m.transformRange(s0, e0, ledger);
    if (!t) continue;
    checked++;
    const want = [];
    for (let i = s0; i < e0; i++) want.push(i);
    assert.deepStrictEqual(ids.slice(t[0], t[1]), want, `seed ${seed}: ${JSON.stringify(ledger)} -> ${t}`);
  }
  assert.ok(checked > 1000);
});

test("shiftAnchor: multi-change event in pre-change coords, straddle leaves it", () => {
  assert.strictEqual(m.shiftAnchor(10, [{ rangeOffset: 2, rangeLength: 0, textLength: 3 }, { rangeOffset: 5, rangeLength: 2, textLength: 0 }]), 11);
  assert.strictEqual(m.shiftAnchor(10, [{ rangeOffset: 8, rangeLength: 4, textLength: 0 }]), 10);
  assert.strictEqual(m.shiftAnchor(10, [{ rangeOffset: 10, rangeLength: 0, textLength: 4 }]), 14);
});

// DEFECT 4 (regression in controller.noteChange): the anchor is shifted by the
// WHOLE event first, then the not-diverged loop compares each change's
// PRE-change rangeOffset against the POST-shift anchor. In a multi-change
// event (rename symbol, replace-all, format-on-save, multi-cursor paste) a
// change inside the walked region's first bytes then reads as "above the
// symbol" and divergence never fires. Calls classifyWalkChanges, the function controller.noteChange now uses.
test("DEFECT controller.noteChange: an in-region change in a multi-change event is missed after the shift", () => {
  const anchor = 100;
  // F2 rename `ix` -> `metablock_ix` (+10 bytes): one use above the symbol,
  // one 3 bytes into the walked region.
  const changes = [
    { rangeOffset: 40, rangeLength: 2, text: "metablock_ix" },
    { rangeOffset: anchor + 3, rangeLength: 2, text: "metablock_ix" },
  ];
  const r = m.classifyWalkChanges(anchor, changes.map((c) => ({ rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, textLength: c.text.length, self: false })));
  const diverged = r.inRegion;
  const shifted = r.anchor;
  assert.strictEqual(diverged, true, `in-region rename at ${anchor + 3} skipped as "above" the shifted anchor ${shifted}`);
});

// ======================= re-attack of the fixes =======================

const BIG = [
  "use std::fmt;",
  "",
  "fn small() {",
  "    a();",
  "}",
  "",
  "fn big() {",
  "    let a = 1;",
  "    let b = 2;",
  "    let c = 3;",
  "    let d = 4;",
  "    let e = 5;",
  "    let f = 6;",
  "}",
  "",
].join("\n");

// The walk's own partial build of a segment after `j` accepts.
function partialWalk(content, spec, j) {
  const steps = m.computeSteps(content, spec);
  let buf = "";
  for (const st of steps.slice(0, j)) buf = buf.slice(0, st.insertOffset) + st.insert + buf.slice(st.insertOffset);
  return { buf, total: steps.length };
}

// NEW DEFECT A: a re-arm mid-segment (some walk accepts landed) with a human
// line typed directly above the segment being walked: the incident's shape
// (TODO above the struct under construction). nextAlreadyHere reads the
// human's line as the first line, and the partial build holds fewer than half
// the segment's lines, so resumeWalk resumes and the runner appends the whole
// segment again below the walk's partial bytes.
test("DEFECT A resumeWalk: partial walk + human line above it never resumes into a double landing", () => {
  const spec = m.RUST;
  const segs = planFileWalk(BIG, spec);
  const k = segs.length - 1;
  const p = preTyped(segs[k], spec);
  assert.ok(p.walkable, "last segment walks");
  const human = "// TODO: human note\n";
  const bad = [];
  const { total } = partialWalk(p.content, spec, 0);
  for (let j = 1; j < total; j++) {
    const part = partialWalk(p.content, spec, j).buf;
    const live = prefix(segs, k) + segs[k].sep + p.pad + human + part + p.tail;
    const r = resumeWalk(segs, live, spec);
    if (!r) continue;
    const out = finishFrom(live, segs, r.at, r.leadTyped, spec);
    const minusHuman = out.replace(human, "");
    if (minusHuman !== BIG) {
      bad.push(`after ${j} accept(s): resumed at=${r.at}; completeCurrent's landedWithAdditions check says ${landedWithAdditions(BIG, out)}; result:\n${out}`);
    }
  }
  assert.deepStrictEqual(bad, [], bad.join("\n----\n"));
});

// NEW DEFECT B: finding 4's fix skips the selfDelta leg on a foreign entry,
// but a foreign edit that touched and restored the range (typo, backspace)
// nulls ledgerRange, and the structural leg is next. A human comment among
// the call's arguments shifts the named-child path onto the equal neighbour.
test("DEFECT B resolveStep: typo-and-fix inside the range + comment before it lands on the wrong occurrence", () => {
  const before = "fn f() {\n    g(alpha, alpha);\n}";
  const after = "fn f() {\n    g(alpha, omega);\n}";
  const steps = m.buildReplaySteps(before, after, m.RUST);
  const st = steps.find((s) => s.originalText === "alpha");
  assert.ok(st);
  const firstArg = before.indexOf("alpha");
  const comment = "/* c */ ";
  let buf = before.slice(0, firstArg) + comment + before.slice(firstArg);
  const q = st.start + comment.length + 2; // inside the second alpha, live coords
  const ledger = [
    { offset: firstArg, rangeLength: 0, textLength: comment.length },
    { offset: q, rangeLength: 0, textLength: 1 }, // typo
    { offset: q, rangeLength: 1, textLength: 0 }, // backspace
  ];
  const r = m.resolveStep(buf, m.parseRoot(buf, m.RUST), st, 0, ledger);
  if (r === null) return; // a collision is honest
  const out = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
  assert.strictEqual(out.replace(comment, ""), after, `wrong merge: ${JSON.stringify(out)}`);
});

// LIMIT C (deferred, documented): below the frontier, a human line equal to
// a next-segment line refuses resume.
test("LIMIT C resumeWalk: a human helper below the frontier sharing a line with the next segment refuses", () => {
  const sandbox = "use std::fmt;\n\nfn one() {\n    a();\n}\n\nfn two() {\n    b();\n}\n";
  const segs = planFileWalk(sandbox, m.RUST);
  assert.strictEqual(segs.length, 3);
  const live = prefix(segs, 2) + "\n\nfn mine() {\n    b();\n}\n"; // the human's helper calls b() too
  assert.strictEqual(resumeWalk(segs, live, m.RUST), undefined);
});

test("LIMIT C' resumeWalk: a python helper below the frontier sharing `return None` with the next segment refuses", () => {
  const sandbox = "import os\n\n\ndef one():\n    return 1\n\n\ndef two():\n    return None\n";
  const segs = planFileWalk(sandbox, m.PYTHON);
  assert.strictEqual(segs.length, 3);
  const live = prefix(segs, 2) + "\n\n\ndef mine():\n    return None\n";
  assert.strictEqual(resumeWalk(segs, live, m.PYTHON), undefined);
});

// blankLineDelta: "adds" must mean live is sandbox with only blank lines
// removed (so landing it removes no live byte), "removes" the mirror.
test("blankLineDelta: adds/removes only ever differ by whole blank lines (property)", () => {
  const atoms = ["a", "  b", "c ", "\tc", "", " ", "\r", "x\r", "  "];
  let classified = 0;
  for (let seed = 1; seed <= 6000; seed++) {
    const R = rng(seed);
    const n = Math.floor(R() * 6);
    const base = Array.from({ length: n }, () => atoms[Math.floor(R() * atoms.length)]);
    const mutate = (lines) => {
      const out = [...lines];
      const ops = Math.floor(R() * 3);
      for (let i = 0; i < ops; i++) {
        const at = Math.floor(R() * (out.length + 1));
        const kind = R();
        if (kind < 0.4) out.splice(at, 0, atoms[4 + Math.floor(R() * 3)]);
        else if (kind < 0.7 && out.length) out.splice(Math.min(at, out.length - 1), 1);
        else if (out.length) out[Math.min(at, out.length - 1)] = atoms[Math.floor(R() * atoms.length)];
      }
      return out;
    };
    const live = base.join("\n") + (R() < 0.5 ? "\n" : "");
    const sandbox = mutate(base).join("\n") + (R() < 0.5 ? "\n" : "");
    const v = m.blankLineDelta(live, sandbox);
    if (!v) continue;
    classified++;
    const [small, big] = v === "adds" ? [live, sandbox] : [sandbox, live];
    // big's lines minus some whole whitespace-only lines must equal small's lines
    const s = small.split("\n");
    const b = big.split("\n");
    let i = 0;
    for (const l of b) {
      if (i < s.length && l === s[i]) i++;
      else assert.ok(l.trim() === "", `seed ${seed} ${v}: non-blank line ${JSON.stringify(l)} differs; live=${JSON.stringify(live)} sandbox=${JSON.stringify(sandbox)}`);
    }
    assert.strictEqual(i, s.length, `seed ${seed} ${v}: live=${JSON.stringify(live)} sandbox=${JSON.stringify(sandbox)}`);
    if (v === "adds") {
      // landBlankLines applies every lineDiffSteps hunk; every live byte must survive in order.
      const hunks = m.lineDiffSteps(live, sandbox);
      for (const h of hunks) assert.ok(h.replacement.includes(h.originalText) || h.originalText === "", `seed ${seed}: hunk drops live bytes ${JSON.stringify(h)}`);
    }
  }
  assert.ok(classified > 300, `classified ${classified}`);
});

test("blankLineDelta: indentation, trailing space, CRLF and no-final-newline cases", () => {
  assert.strictEqual(m.blankLineDelta("def f():\n    x\n", "def f():\n  x\n"), undefined, "indent change");
  assert.strictEqual(m.blankLineDelta("a \n", "a\n"), undefined, "trailing space");
  assert.strictEqual(m.blankLineDelta("a\nb\n", "a\r\nb\r\n"), undefined, "LF -> CRLF");
  assert.strictEqual(m.blankLineDelta("a\nb", "a\nb\n"), "adds", "final newline");
  assert.strictEqual(m.blankLineDelta("a\nb\n", "a\nb"), "removes", "drop final newline");
  assert.strictEqual(m.blankLineDelta("a\r\nb\r\n", "a\r\n\r\nb\r\n"), "adds", "CRLF blank line");
  assert.strictEqual(m.blankLineDelta("a\n  \nb\n", "a\n\nb\n"), undefined, "whitespace-only line changed");
});

// ======================= loop 3 re-attack =======================

// NEW DEFECT E (A's guard is bypassed through the PREFIX match): the prefix's
// lines are matched earliest-first, and lines inside the matched prefix are
// unrestricted. A human trailing comment on the landed segment's closing line
// (`} // end small`) unmatches it, so the prefix's `}` matches the walk's
// partial shell `}` BELOW. The partial build is then "inside the prefix",
// belowFrontierSafe sees nothing, and the runner appends the segment again.
test("DEFECT E resumeWalk: a comment on the landed `}` + a partial walk below never double-lands", () => {
  const spec = m.RUST;
  const segs = planFileWalk(BIG, spec);
  const k = segs.length - 1;
  const p = preTyped(segs[k], spec);
  const landed = prefix(segs, k);
  const cut = landed.lastIndexOf("}");
  const humanLanded = landed.slice(0, cut) + "} // end small" + landed.slice(cut + 1);
  const bad = [];
  const { total } = partialWalk(p.content, spec, 0);
  for (let j = 1; j < total; j++) {
    const part = partialWalk(p.content, spec, j).buf;
    const live = humanLanded + segs[k].sep + p.pad + part + p.tail;
    const r = resumeWalk(segs, live, spec);
    if (!r) continue;
    const out = finishFrom(live, segs, r.at, r.leadTyped, spec);
    const n = out.split("fn big()").length - 1;
    if (n !== 1) bad.push(`after ${j} accept(s): resumed at=${r.at}, \`fn big()\` landed ${n} times:\n${out}`);
  }
  assert.deepStrictEqual(bad, [], bad.join("\n----\n"));
});

// NEW DEFECT F (B's remaining route, the content leg): the human rewrote the
// step's own occurrence, so the other equal occurrence is now UNIQUE and
// resolveByContent claims it. The step that the human took over lands on a
// neighbour they never touched.
test("DEFECT F resolveStep: the human rewrites the target occurrence; the content leg moves the step onto the other one", () => {
  const before = "fn f() {\n    g(alpha, alpha);\n}";
  const after = "fn f() {\n    g(alpha, omega);\n}";
  const steps = m.buildReplaySteps(before, after, m.RUST);
  const st = steps.find((s) => s.originalText === "alpha");
  assert.ok(st);
  const buf = before.slice(0, st.start) + "gamma" + before.slice(st.end); // human: second alpha -> gamma
  const ledger = [{ offset: st.start, rangeLength: 5, textLength: 5 }];
  const r = m.resolveStep(buf, m.parseRoot(buf, m.RUST), st, 0, ledger);
  if (r === null) return; // collision/hold is honest
  const out = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
  assert.fail(`landed on bytes the human did not hand over: ${JSON.stringify(out)} (sandbox wants the SECOND arg replaced, human made it gamma)`);
});

// Block-comment-shaped and doc-comment partials: a walk whose first step is
// leading trivia lands those lines verbatim, so they match the next segment
// and refuse. Checks the guard's comment allowance can't be fed by the walk.
test("resumeWalk: a doc-commented next segment's partial walk build refuses", () => {
  const sandbox = "use std::fmt;\n\n/// Big docs.\n/* block */\nfn big() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n    let d = 4;\n}\n";
  const spec = m.RUST;
  const segs = planFileWalk(sandbox, spec);
  const k = segs.length - 1;
  const p = preTyped(segs[k], spec);
  assert.ok(p.walkable);
  const { total } = partialWalk(p.content, spec, 0);
  for (let j = 1; j < total; j++) {
    const part = partialWalk(p.content, spec, j).buf;
    const live = prefix(segs, k) + segs[k].sep + p.pad + "// TODO human\n" + part + p.tail;
    const r = resumeWalk(segs, live, spec);
    if (!r) continue;
    const out = finishFrom(live, segs, r.at, r.leadTyped, spec);
    assert.strictEqual(out.replace("// TODO human\n", ""), sandbox, `after ${j}: double landing`);
  }
});
