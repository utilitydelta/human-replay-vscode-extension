#!/usr/bin/env node
// Headless replay-guide validator — the oracle a guide author (human or agent)
// iterates against before a guide ever reaches F5.
//
// Runs the REAL engine code (esbuild-bundled, same as the test oracles): parses
// the guide, resolves every step's bytes from the target and sandbox trees, and
// for each modify step replays the controller's exact sequential policy to prove
// the walk lands byte-exact. A guide that passes here parses in the extension and
// every step will resolve at the keyboard.
//
// usage: node scripts/validate-guide.js <guide.md> <targetRoot> <sandboxRoot>
// exit 0: every step validates. exit 1: failures (listed). exit 2: bad usage.

const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const [, , guidePath, targetRoot, sandboxRoot] = process.argv;
if (!guidePath || !targetRoot || !sandboxRoot) {
  console.error("usage: node scripts/validate-guide.js <guide.md> <targetRoot> <sandboxRoot>");
  process.exit(2);
}

const bundle = path.join(__dirname, ".validate.bundle.cjs");
const entry = path.join(__dirname, ".validate.entry.ts");
fs.writeFileSync(
  entry,
  `export { parseGuide } from "../src/disclosure/guide";\n` +
    `export { extractSymbol, stepAlreadyLanded } from "../src/disclosure/resume";\n` +
    `export { classifyReplay } from "../src/disclosure/strategy";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n` +
    `export { resolveStep } from "../src/disclosure/replay";\n` +
    `export { parseRoot } from "../src/disclosure/diff";\n` +
    `export { languageForFile } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown"],
});
const { parseGuide, extractSymbol, stepAlreadyLanded, classifyReplay, buildReplaySteps, resolveStep, parseRoot, languageForFile } =
  require(bundle);
const cleanup = () => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
};

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

// First-match resolution makes a repeated item name in one file a silent wrong
// target — surface it as a failure, not a footnote.
const countDefs = (text, name) => {
  if (text === undefined) return 0;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b(?:fn|struct|enum|union|const|static|type|trait|mod|macro_rules!)\\s+${esc}\\b`, "g");
  return (text.match(re) ?? []).length;
};

// The controller's exact interactive loop: arithmetic-first resolveStep with
// selfDelta bookkeeping. Proves every op of a modify step resolves and the walk
// lands byte-exact — the same invariant the sequential-replay oracles pin.
const sequentialReplay = (before, after, spec) => {
  const steps = buildReplaySteps(before, after, spec);
  let buf = before;
  let delta = 0;
  for (const [i, st] of steps.entries()) {
    const r = resolveStep(buf, parseRoot(buf, spec), st, delta);
    if (!r) return { ok: false, ops: steps.length, failedOp: i };
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    delta += st.replacement.length - (r[1] - r[0]);
  }
  return { ok: buf === after, ops: steps.length };
};

let guide;
try {
  guide = parseGuide(fs.readFileSync(guidePath, "utf8"));
} catch (e) {
  console.error(`PARSE FAIL: ${e.message ?? e}`);
  cleanup();
  process.exit(1);
}

console.log(`guide "${guide.feature}": ${guide.steps.length} steps, ${guide.invariants.length} invariants\n`);
const failures = [];
const note = (step, status, detail = "") =>
  console.log(`  ${status.padEnd(9)} ${step.id.padEnd(5)} ${step.action.padEnd(11)} ${step.symbol}${detail ? ` — ${detail}` : ""}`);

for (const step of guide.steps) {
  const rel = step.file.split(":")[0];
  const targetText = read(path.join(targetRoot, rel));
  const sandboxText = read(path.join(sandboxRoot, rel));

  if (step.action === "create-file") {
    if (sandboxText === undefined) {
      failures.push(step.id);
      note(step, "FAIL", `sandbox file ${rel} unreadable`);
    } else if (stepAlreadyLanded("create-file", targetText, sandboxText)) {
      note(step, "landed", "target file already byte-identical");
    } else if (targetText !== undefined) {
      note(step, "CONFLICT", `${rel} exists in the target and differs — replay will block`);
    } else {
      note(step, "ok", `${sandboxText.length} bytes`);
    }
    continue;
  }

  const spec = languageForFile(rel);
  if (!spec) {
    failures.push(step.id);
    note(step, "FAIL", `no language support for ${rel} — route to Manual steps or Create File`);
    continue;
  }
  const before = step.before ?? (targetText === undefined ? undefined : extractSymbol(targetText, step.symbol, spec));
  const after = step.after ?? (sandboxText === undefined ? undefined : extractSymbol(sandboxText, step.symbol, spec));
  const dupT = countDefs(targetText, step.symbol);
  const dupS = countDefs(sandboxText, step.symbol);
  if (dupT > 1 || dupS > 1) {
    failures.push(step.id);
    note(step, "FAIL", `"${step.symbol}" defined ${Math.max(dupT, dupS)}x in ${rel} — first-match would resolve wrong`);
    continue;
  }

  if (step.action === "delete") {
    if (before === undefined) note(step, "landed", "symbol already gone from the target");
    else note(step, "ok", "strikes the existing symbol");
    continue;
  }
  if (after === undefined) {
    failures.push(step.id);
    note(step, "FAIL", `symbol not found in sandbox ${rel}`);
    continue;
  }
  if (step.action === "create") {
    if (stepAlreadyLanded("create", before, after)) note(step, "landed", "already byte-identical in the target");
    else if (before !== undefined) note(step, "ok", "exists in target — resumes as diff-replay");
    else note(step, "ok", `${after.length} bytes, disclosure walk`);
    continue;
  }
  // modify
  if (before === undefined) {
    failures.push(step.id);
    note(step, "FAIL", `symbol not found in target ${rel}`);
    continue;
  }
  if (stepAlreadyLanded("modify", before, after)) {
    note(step, "landed", "already byte-identical in the target");
    continue;
  }
  const plan = classifyReplay(before, after, spec);
  const seq = sequentialReplay(before, after, spec);
  if (plan.strategy === "surgical" && !seq.ok) {
    failures.push(step.id);
    note(step, "FAIL", `sequential replay ${seq.failedOp !== undefined ? `collides at op ${seq.failedOp}` : "not byte-exact"} (${seq.ops} ops)`);
  } else {
    note(step, "ok", `${plan.strategy} (survival ${Math.round(plan.survival * 100)}%, ${seq.ops} ops${plan.strategy === "surgical" ? ", sequential byte-exact" : ""})`);
  }
}

cleanup();
console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"}: ${guide.steps.length - failures.length}/${guide.steps.length} steps validate${failures.length ? ` — fix: ${failures.join(", ")}` : ""}`);
process.exit(failures.length === 0 ? 0 : 1);
