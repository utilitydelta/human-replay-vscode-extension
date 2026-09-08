#!/usr/bin/env node
// The field harness — real edits, real bytes, the real engine.
//
// The test oracles run on corpora an author chose. This runs on corpora nobody
// chose: every changed symbol in a repo's git history, paired before/after and
// pushed through `extractSymbol -> buildReplaySteps -> resolveStep` exactly as
// the controller drives it. A failure here is a step that would collide at the
// keyboard, or land bytes that are not the sandbox's — the two shapes that send
// the human back to copy-paste. It found four defects on its first run; it is
// the instrument that proves the next one is not there.
//
// Not part of `npm test` (it needs repos this repo does not own). The corpora it
// distils are: see `test/field-defects.test.cjs`.
//
// usage: node scripts/harvest-replay.js [--commits N] [--json out.json] <repo>...
// exit 0: every pair replayed byte-exact. exit 1: failures (census + samples).
// exit 2: bad usage.

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const esbuild = require("esbuild");

// --- arguments -------------------------------------------------------------
const argv = process.argv.slice(2);
const repos = [];
let maxCommits = 40;
let jsonOut;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--commits") maxCommits = Number(argv[++i]);
  else if (argv[i] === "--json") jsonOut = argv[++i];
  else repos.push(argv[i]);
}
if (repos.length === 0 || !Number.isFinite(maxCommits) || maxCommits < 1) {
  console.error("usage: node scripts/harvest-replay.js [--commits N] [--json out.json] <repo>...");
  process.exit(2);
}

// --- the real engine -------------------------------------------------------
// Per-process names: two harvests can run at once (a review agent and a
// census), and a shared bundle path means one run's cleanup deletes the
// other's module.
const bundle = path.join(__dirname, `.harvest.${process.pid}.bundle.cjs`);
const entry = path.join(__dirname, `.harvest.${process.pid}.entry.ts`);
fs.writeFileSync(
  entry,
  `export { extractSymbol } from "../src/disclosure/resume";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n` +
    `export { resolveStep } from "../src/disclosure/replay";\n` +
    `export { parseRoot } from "../src/disclosure/diff";\n` +
    `export { computeSteps, walkableSource, findItemByName, leadingTriviaStart, namedChildren } from "../src/disclosure/walk";\n` +
    `export { planFileWalk } from "../src/disclosure/fileWalk";\n` +
    `export { planCreateInsertion, splitLeadingPad } from "../src/disclosure/insertion";\n` +
    `export { lineDiffSteps } from "../src/disclosure/lineDiff";\n` +
    `export { languageForFile } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { extractSymbol, buildReplaySteps, resolveStep, parseRoot, computeSteps, walkableSource, leadingTriviaStart, planFileWalk, planCreateInsertion, splitLeadingPad, lineDiffSteps, languageForFile } =
  require(bundle);
const cleanup = () => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
};
process.on("exit", cleanup);

// --- limits ----------------------------------------------------------------
// A pair bigger than these is not a replay step a human would ever Tab through;
// skipping keeps one generated file from dominating the census.
const MAX_FILE_BYTES = 250_000;
const MAX_SYMBOL_BYTES = 40_000;
// A single pair that takes longer than this is a defect of its own: the
// extension host is single-threaded and the human is holding Tab.
const SLOW_MS = 2_000;

const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
const show = (repo, rev) => {
  try {
    // stderr piped: a path that exists on one side only is the normal case for
    // an added or renamed file, and git's "fatal:" line is not news.
    return execFileSync("git", ["-C", repo, "show", rev], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return undefined; // added, deleted, or renamed on one side — not a modify pair
  }
};

// The controller's exact interactive loop.
function replaySequential(before, steps, spec) {
  let buf = before;
  let selfDelta = 0;
  const ledger = [];
  for (const [i, st] of steps.entries()) {
    const r = resolveStep(buf, parseRoot(buf, spec), st, selfDelta, ledger);
    if (!r) return { ok: false, why: `step ${i + 1}/${steps.length} collided (the collision modal)` };
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
    ledger.push({ offset: r[0], rangeLength: r[1] - r[0], textLength: st.replacement.length, self: true });
  }
  return { ok: true, buf };
}

function replayWalk(src, spec) {
  let buf = "";
  let cursor = 0;
  for (const s of computeSteps(src, spec)) {
    buf = buf.slice(0, cursor) + s.insert + buf.slice(cursor);
    cursor = s.cursorOffset;
  }
  return buf;
}

function replayLinePatch(before, after) {
  let buf = before;
  let delta = 0;
  for (const st of lineDiffSteps(before, after)) {
    const start = st.start + delta;
    const end = st.end + delta;
    buf = buf.slice(0, start) + st.replacement + buf.slice(end);
    delta += st.replacement.length - (st.end - st.start);
  }
  return buf;
}

// Every addressable name in a file, mapped to the exact bytes `extractSymbol`
// would return for it — one parse per file instead of one per symbol. Mirrors
// `findItemByName`: first match wins, and a lift wrapper directly above the item
// owns its bytes.
function symbolBytes(text, spec) {
  const out = new Map();
  let root;
  try {
    root = parseRoot(text, spec);
  } catch {
    return out;
  }
  (function walk(node, lift) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (spec.namedItemTypes.has(child.type)) {
        const name = spec.nameOf(child, text);
        const held = lift ?? child;
        if (name !== undefined && !out.has(name)) {
          out.set(name, text.slice(leadingTriviaStart(text, held.startIndex, spec), held.endIndex));
        }
      }
      walk(child, spec.liftParents.has(child.type) ? (lift ?? child) : null);
    }
  })(root, null);
  return out;
}

// --- the run ---------------------------------------------------------------
const failures = [];
let filePairs = 0;
let symbolPairs = 0;
let createCases = 0;

for (const repo of repos) {
  let commits;
  try {
    commits = git(repo, ["rev-list", "--no-merges", `-${maxCommits}`, "HEAD"]).trim().split("\n").filter(Boolean);
  } catch (e) {
    console.error(`skipping ${repo}: ${e.message.split("\n")[0]}`);
    continue;
  }
  for (const sha of commits) {
    let files;
    try {
      files = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).trim().split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (const rel of files) {
      const spec = languageForFile(rel);
      if (!spec) continue;
      const before = show(repo, `${sha}^:${rel}`);
      const after = show(repo, `${sha}:${rel}`);
      if (before === undefined || after === undefined) continue;
      if (before === after) continue;
      if (before.length > MAX_FILE_BYTES || after.length > MAX_FILE_BYTES) continue;
      filePairs++;
      const fail = (kind, symbol, why) => failures.push({ kind, repo, sha, file: rel, symbol, why });

      // Segmentation is the create-file gesture: it must rebuild the file.
      try {
        const segments = planFileWalk(after, spec);
        if (segments.map((s) => s.sep + s.body).join("") !== after) {
          fail("file-walk-not-byte-exact", "", "the segments do not concatenate back to the file");
        }
      } catch (e) {
        fail("file-walk-threw", "", e.message.split("\n")[0]);
      }

      const beforeSymbols = symbolBytes(before, spec);
      const afterSymbols = symbolBytes(after, spec);

      for (const [name, b] of beforeSymbols) {
        const a = afterSymbols.get(name);
        if (a === undefined || a === b) continue;
        if (b.length > MAX_SYMBOL_BYTES || a.length > MAX_SYMBOL_BYTES) continue;
        symbolPairs++;
        const started = Date.now();
        try {
          const result = replaySequential(b, buildReplaySteps(b, a, spec), spec);
          if (!result.ok) fail("modify-collided", name, result.why);
          else if (result.buf !== a) fail("modify-wrong-bytes", name, "the replay landed bytes the sandbox does not have");
        } catch (e) {
          fail("modify-threw", name, e.message.split("\n")[0]);
        }
        try {
          if (replayLinePatch(b, a) !== a) fail("patch-wrong-bytes", name, "the line-grain patch did not rebuild the symbol");
        } catch (e) {
          fail("patch-threw", name, e.message.split("\n")[0]);
        }
        const elapsed = Date.now() - started;
        if (elapsed > SLOW_MS) fail("slow", name, `${elapsed}ms for ${b.length} -> ${a.length} bytes`);
      }

      // Symbols only on the after side are create steps. Two halves, and the
      // second one is the half an adversarial review found missing: rebuilding
      // the symbol proves the BYTES, and says nothing about WHERE they land.
      for (const [name, a] of afterSymbols) {
        if (beforeSymbols.has(name) || a.length > MAX_SYMBOL_BYTES) continue;
        createCases++;
        try {
          if (walkableSource(a, spec)) {
            if (replayWalk(a, spec) !== a) fail("create-walk-wrong-bytes", name, "the walk did not rebuild the symbol");
          } else {
            const result = replaySequential("", buildReplaySteps("", a, spec), spec);
            if (!result.ok) fail("create-collided", name, result.why);
            else if (result.buf !== a) fail("create-wrong-bytes", name, "the whole-symbol insert did not rebuild the symbol");
          }
        } catch (e) {
          fail("create-threw", name, e.message.split("\n")[0]);
        }
        // Placement: plan against the real before-file, land the symbol the way
        // the runner does, and demand the column be whitespace the TARGET
        // itself uses. A synthesized column spells a tab as spaces — a byte
        // that is in neither file, and one nothing downstream can see, because
        // extraction excludes the first line's indent.
        try {
          const plan = planCreateInsertion(before, after, name, spec);
          if (plan.kind === "container") {
            const scaffolded = before.slice(0, plan.start) + plan.scaffold + before.slice(plan.end);
            const { pad, rest } = splitLeadingPad(a);
            const built = scaffolded.slice(0, plan.cursorAt) + pad + rest + scaffolded.slice(plan.cursorAt);
            const landedIndent = /^[ \t]*/.exec(plan.scaffold.split("\n").pop() ?? "")[0];
            if (landedIndent !== "" && !before.includes(`\n${landedIndent}`)) {
              fail("create-invented-indent", name, `landed an indent the target never uses: ${JSON.stringify(landedIndent)}`);
            } else if (!built.includes(a)) {
              fail("create-placement-lost-bytes", name, "the symbol's own bytes did not survive placement");
            }
          }
        } catch (e) {
          fail("create-placement-threw", name, e.message.split("\n")[0]);
        }
      }
    }
  }
  process.stderr.write(
    `${path.basename(repo)}: ${filePairs} file pairs, ${symbolPairs} modify pairs, ${createCases} creates, ${failures.length} failures so far\n`,
  );
}

// --- the census ------------------------------------------------------------
console.log(
  `harvested ${filePairs} changed files, ${symbolPairs} modify pairs, ${createCases} create cases across ${repos.length} repo(s)`,
);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(failures, null, 1));

if (failures.length === 0) {
  console.log("PASS — every pair replayed byte-exact");
  process.exit(0);
}

const byKind = new Map();
for (const f of failures) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
console.log(`FAIL — ${failures.length} failures (${((failures.length / Math.max(1, symbolPairs)) * 100).toFixed(1)}% of modify pairs)`);
for (const [kind, n] of [...byKind].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(4)}  ${kind}`);
console.log("\nfirst five of each kind:");
const shown = new Map();
for (const f of failures) {
  const n = (shown.get(f.kind) ?? 0) + 1;
  shown.set(f.kind, n);
  if (n > 5) continue;
  console.log(`  ${f.kind}  ${f.file} [${f.symbol}] :: ${f.why}  (${f.sha.slice(0, 8)} ${path.basename(f.repo)})`);
}
process.exit(1);
