#!/usr/bin/env node
// Headless replay-guide validator — the oracle a guide author (human or agent)
// iterates against before a guide ever reaches F5.
//
// Runs the REAL engine code (esbuild-bundled, same as the test oracles): parses
// the guide, resolves every step's bytes from the target and sandbox trees, and
// for each modify step replays the controller's exact sequential policy to prove
// the walk lands byte-exact. Create steps prove their landing spot too — the
// runner's placement plan (inside the matching container for a nested symbol,
// end-of-file for a top-level one) must resolve, or the step fails here instead
// of at the keyboard. The whole run is a sequential dry-run: each step's outcome
// is applied to an in-memory copy of the target, so later steps validate against
// the tree as it will actually stand when they run. A guide that passes here
// parses in the extension and every step will resolve at the keyboard.
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
    `export { languageForFile } from "../src/disclosure/language";\n` +
    `export { planCreateInsertion, separatorToInsert, splitLeadingPad } from "../src/disclosure/insertion";\n` +
    `export { walkableSource } from "../src/disclosure/walk";\n` +
    `export { lineDiffSteps } from "../src/disclosure/lineDiff";\n` +
    `export { resolveStepNoTree } from "../src/disclosure/replay";\n` +
    `export { planFileWalk, splitTrailing } from "../src/disclosure/fileWalk";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { parseGuide, extractSymbol, stepAlreadyLanded, classifyReplay, buildReplaySteps, resolveStep, parseRoot, languageForFile, planCreateInsertion, separatorToInsert, splitLeadingPad, walkableSource, lineDiffSteps, resolveStepNoTree, planFileWalk, splitTrailing } =
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

// The sequential dry-run state: target texts as they stand after the steps
// validated so far. Reads fall through to disk for untouched files.
const simulated = new Map();
// Files a create-file step materialized. A decomposed new file (skeleton +
// symbol steps) must END as the sandbox file — a gap means the generator
// forgot a symbol, and the human would finish the replay with a broken file.
const createdFiles = new Set();
const targetTextFor = (rel) => (simulated.has(rel) ? simulated.get(rel) : read(path.join(targetRoot, rel)));

// Land a step's outcome in the dry-run state: the target symbol's bytes become
// the sandbox's. Splice by offset, not String.replace ($-patterns corrupt code).
const spliceBytes = (text, from, to) => {
  const at = text.indexOf(from);
  return at < 0 ? text : text.slice(0, at) + to + text.slice(at + from.length);
};

for (const step of guide.steps) {
  const rel = step.file.split(":")[0];
  const targetText = targetTextFor(rel);
  const sandboxText = read(path.join(sandboxRoot, rel));

  if (step.action === "create-file") {
    // A fenced create-file lands its After fence — the file's SKELETON, grown
    // by the symbol create steps that follow. Unfenced lands the whole file.
    const bytes = step.after ?? sandboxText;
    const skeleton = step.after !== undefined;
    if (bytes === undefined) {
      failures.push(step.id);
      note(step, "FAIL", `sandbox file ${rel} unreadable`);
    } else if (skeleton && sandboxText !== undefined && !sandboxText.startsWith(bytes)) {
      failures.push(step.id);
      note(step, "FAIL", `skeleton fence is not a prefix of the sandbox file — the symbol steps can never converge`);
    } else if (skeleton ? targetText !== undefined && targetText.startsWith(bytes) : stepAlreadyLanded("create-file", targetText, bytes)) {
      note(step, "landed", skeleton ? "target already carries the skeleton" : "target file already byte-identical");
    } else if (targetText !== undefined) {
      note(step, "CONFLICT", `${rel} exists in the target and differs — replay will block`);
    } else {
      // The runner's exact file walk: the segments must rebuild the step's
      // bytes exactly, or a Tab at the keyboard would land wrong bytes.
      const fileSpec = languageForFile(rel);
      const segs = planFileWalk(bytes, fileSpec);
      const rebuilt = segs.map((s) => s.sep + s.body).join("");
      if (rebuilt !== bytes) {
        failures.push(step.id);
        note(step, "FAIL", `file walk is not byte-exact (${segs.length} segment(s))`);
      } else {
        // The runner's per-segment routing: walk when the content (trailing
        // whitespace typed) rebuilds byte-exact, block ghost otherwise.
        const walks = segs.filter((s) => {
          const { content } = splitTrailing(splitLeadingPad(s.body).rest);
          return fileSpec && content !== "" && walkableSource(content, fileSpec);
        }).length;
        simulated.set(rel, bytes);
        createdFiles.add(rel);
        note(step, "ok", `${bytes.length} bytes${skeleton ? " (skeleton)" : ""}, ${segs.length} segment(s) (${walks} walk, ${segs.length - walks} block)`);
      }
    }
    continue;
  }

  if (step.action === "patch") {
    if (sandboxText === undefined) {
      failures.push(step.id);
      note(step, "FAIL", `sandbox file ${rel} unreadable`);
    } else if (targetText === undefined) {
      failures.push(step.id);
      note(step, "FAIL", `target file ${rel} unreadable — a patch needs an existing file`);
    } else if (targetText === sandboxText) {
      note(step, "landed", "target file already byte-identical");
    } else {
      // The runner's exact hunk replay: line diff, each hunk resolved by the
      // parse-free legs, sequentially. Byte-exact or the guide fails.
      const hunks = lineDiffSteps(targetText, sandboxText);
      let buf = targetText;
      let selfDelta = 0;
      let dead = false;
      for (const h of hunks) {
        const r = resolveStepNoTree(buf, h, selfDelta);
        if (!r) { dead = true; break; }
        buf = buf.slice(0, r[0]) + h.replacement + buf.slice(r[1]);
        selfDelta += h.replacement.length - (r[1] - r[0]);
      }
      if (dead || buf !== sandboxText) {
        failures.push(step.id);
        note(step, "FAIL", `patch replay is not byte-exact (${hunks.length} hunk(s))`);
      } else {
        simulated.set(rel, sandboxText);
        note(step, "ok", `${hunks.length} hunk(s), sequential byte-exact`);
      }
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
    else {
      simulated.set(rel, spliceBytes(targetText, before, ""));
      note(step, "ok", "strikes the existing symbol");
    }
    continue;
  }
  if (after === undefined) {
    failures.push(step.id);
    note(step, "FAIL", `symbol not found in sandbox ${rel}`);
    continue;
  }
  if (step.action === "create") {
    if (stepAlreadyLanded("create", before, after)) {
      note(step, "landed", "already byte-identical in the target");
    } else if (before !== undefined) {
      simulated.set(rel, spliceBytes(targetText, before, after));
      note(step, "ok", "exists in target — resumes as diff-replay");
    } else if (targetText === undefined) {
      failures.push(step.id);
      note(step, "FAIL", `target file ${rel} unreadable — a symbol create needs an existing file`);
    } else {
      // The runner's exact placement + surface decisions, against the dry-run
      // target. The symbol's own first-line indent is typed as pad bytes (a
      // whitespace-leading ghost can't be Tab-accepted); the walk judges the
      // rest at the pad's column.
      const placement = planCreateInsertion(targetText, sandboxText, step.symbol, spec);
      const indent = placement.kind === "container" ? placement.indent : 0;
      const { pad, rest } = splitLeadingPad(after);
      const surface = walkableSource(rest, spec) ? "disclosure walk" : "whole-symbol";
      if (placement.kind === "blocked") {
        failures.push(step.id);
        note(step, "FAIL", `placement blocked — ${placement.reason}`);
      } else if (placement.kind === "container") {
        const scaffolded = targetText.slice(0, placement.start) + placement.scaffold + targetText.slice(placement.end);
        simulated.set(rel, scaffolded.slice(0, placement.cursorAt) + after + scaffolded.slice(placement.cursorAt));
        note(step, "ok", `${after.length} bytes, ${surface} inside \`${placement.container}\``);
      } else {
        simulated.set(rel, targetText + separatorToInsert(targetText) + after);
        note(step, "ok", `${after.length} bytes, ${surface} at end of file`);
      }
    }
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
    simulated.set(rel, spliceBytes(targetText, before, after));
    note(step, "ok", `${plan.strategy} (survival ${Math.round(plan.survival * 100)}%, ${seq.ops} ops${plan.strategy === "surgical" ? ", sequential byte-exact" : ""})`);
  }
}

// Completeness: every file this guide creates must end byte-identical to the
// sandbox once all its steps have run. Scoped to created files — pre-existing
// target files can drift for reasons outside this guide.
for (const rel of createdFiles) {
  const finalText = simulated.get(rel);
  const sandboxText = read(path.join(sandboxRoot, rel));
  if (sandboxText !== undefined && finalText !== sandboxText) {
    failures.push(rel);
    console.log(`\n  FAIL      ${rel} — created file ends ${finalText.length} bytes vs sandbox ${sandboxText.length}: the guide's steps don't rebuild it whole (missing symbol steps or a final patch)`);
  }
}

cleanup();
console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"}: ${guide.steps.length - failures.length}/${guide.steps.length} steps validate${failures.length ? ` — fix: ${failures.join(", ")}` : ""}`);
process.exit(failures.length === 0 ? 0 : 1);
