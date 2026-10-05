// The re-arm incident (session-v4) — a human comment, a re-arm click, and a
// "finish this symbol by hand" that neither one caused alone.
//
// Recorded bytes: `field-rs-rearm-sandbox.rs` is the sandbox file of a
// 16-segment create-file walk (celeriant-db-v8, metablock_model.rs) and
// `field-rs-rearm-live.rs` the target at the moment of the toast: segments
// 1-11 landed, the human's TODO line at Ln76, and segment 12's lead separator
// typed. Segment 12 itself was armed as pending bytes when the human clicked
// the in-flight step to re-arm it.
//
// The re-arm cancelled the session, whose pending-bytes removal ran
// fire-and-forget, and the re-run read the buffer before that removal landed.
// The invariant: a patch is planned from the buffer it will resolve against.
// Planned from the stale snapshot, the remainder hunk targets bytes that are
// gone a moment later and collides (the incident). Planned from the settled
// buffer, the human skips the hunk that would delete their TODO and the
// remainder lands with the TODO kept.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const bundle = path.join(__dirname, ".rearm-incident.bundle.cjs");
const entry = path.join(__dirname, ".rearm-incident.entry.ts");
fs.writeFileSync(
  entry,
  `export { lineDiffSteps } from "../src/disclosure/lineDiff";\n` +
    `export { resolveStepNoTree } from "../src/disclosure/replay";\n` +
    `export { planFileWalk, resumeWalk, landedWithAdditions } from "../src/disclosure/fileWalk";\n` +
    `export { stepAlreadyLanded } from "../src/disclosure/resume";\n` +
    `export { RUST } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { lineDiffSteps, resolveStepNoTree, planFileWalk, resumeWalk, landedWithAdditions, stepAlreadyLanded, RUST } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const sandbox = fs.readFileSync(path.join(__dirname, "corpus/field-rs-rearm-sandbox.rs"), "utf8");
const live = fs.readFileSync(path.join(__dirname, "corpus/field-rs-rearm-live.rs"), "utf8");
const TODO = "// TODO: I forgot what extra I need to include in here. It's documented in the bog in Celeriant notes somewhere.\n";

// Walk the hunks the way the patch surface does: the human skips any hunk
// that would remove their own line, every other hunk lands where it resolves.
function replayKeepingHuman(planFrom, buffer) {
  const steps = lineDiffSteps(planFrom, sandbox);
  let buf = buffer;
  let selfDelta = 0;
  const ledger = [];
  for (const [i, st] of steps.entries()) {
    if (st.originalText.includes("// TODO")) continue; // Shift+Esc: keep mine
    const r = resolveStepNoTree(buf, st, selfDelta, ledger);
    if (!r) return { collidedAt: i, text: buf };
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
    ledger.push({ offset: r[0], rangeLength: r[1] - r[0], textLength: st.replacement.length, self: true });
  }
  return { text: buf };
}

test("the recorded target is the sandbox's first 11 segments, the TODO, and segment 12's lead", () => {
  const segs = planFileWalk(sandbox, RUST);
  const prefix = segs.slice(0, 11).map((s) => s.sep + s.body).join("") + segs[11].sep;
  assert.strictEqual(live.replace(TODO, ""), prefix);
});

test("planned from the stale snapshot (pending bytes not yet removed), the remainder collides", () => {
  const segs = planFileWalk(sandbox, RUST);
  const stale = live + segs[11].body; // what the re-run read before the removal landed
  const out = replayKeepingHuman(stale, live);
  assert.notStrictEqual(out.collidedAt, undefined, "the incident: a hunk aimed at vanished bytes");
});

test("planned from the settled buffer, the remainder lands and the human's TODO survives", () => {
  const out = replayKeepingHuman(live, live);
  assert.strictEqual(out.collidedAt, undefined);
  const lines = sandbox.split("\n");
  const at = lines.findIndex((l) => l === "pub struct SoftDelete {") - 1; // the TODO sits above the derive
  lines.splice(at, 0, TODO.trimEnd());
  assert.strictEqual(out.text, lines.join("\n"));
});

// With the tolerant resume, the re-arm never reaches patch mode: the walk
// picks up at segment 12, types nothing of the lead it already typed, and
// appends the rest. The TODO stays where the human put it.
test("the re-arm resumes the walk at segment 12 with the lead already typed", () => {
  const segs = planFileWalk(sandbox, RUST);
  const r = resumeWalk(segs, live);
  assert.deepStrictEqual(r, { at: 11, leadTyped: segs[11].sep.length });
  let out = live + segs[11].sep.slice(r.leadTyped) + segs[11].body;
  for (const s of segs.slice(12)) out += s.sep + s.body;
  const lines = sandbox.split("\n");
  lines.splice(lines.indexOf("pub struct SoftDelete {") - 1, 0, TODO.trimEnd());
  assert.strictEqual(out, lines.join("\n"));
  assert.strictEqual(landedWithAdditions(sandbox, out), true, "the finished file reads as landed, TODO and all");
  assert.strictEqual(stepAlreadyLanded("create-file", out, sandbox), true);
  assert.strictEqual(stepAlreadyLanded("modify", out, sandbox), false, "a modify has a base: still byte-exact");
});

// Human CODE is welcome inside the landed part: the walk never writes there.
// Below the frontier it refuses resume (indistinguishable from a partial walk
// build), which is a documented limit, not a defect (session-v4/limits.md).
test("a human helper fn between landed segments resumes; below the frontier it refuses", () => {
  const segs = planFileWalk(sandbox, RUST);
  const landed = segs.slice(0, 13).map((s) => s.sep + s.body).join("");
  const helper = "fn my_helper() -> u8 {\n    0\n}\n\n";
  const at = landed.indexOf("#[derive(Clone, PartialEq, Eq, Debug)]\npub struct SoftDelete");
  const inside = landed.slice(0, at) + helper + landed.slice(at);
  assert.deepStrictEqual(resumeWalk(segs, inside, RUST), { at: 13, leadTyped: 0 });
  assert.strictEqual(resumeWalk(segs, landed + "\n\n" + helper, RUST), undefined);
});
