// Oracle for replay units: the guide format that cuts a replay into 30 to 60
// minute sittings (src/disclosure/guide.ts, unitBudget.ts), the record the
// replay writes back (replayRecord.ts), and the validator that refuses a unit
// over budget (scripts/validate-guide.js).
//
// The invariants that earn this file:
//   - a unit over budget never reaches the human: the validator FAILs it;
//   - an outside-in unit keeps its order: red tests before bodies, the grill
//     before typed debt, comments after the code they comment;
//   - a shell never panics and `Unbuilt` never survives the guide;
//   - a ruling is a pick by name from the guide's own options, and the record
//     line carries the decision, the choice, the unit and the step.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");
const esbuild = require("esbuild");

const entry = path.join(__dirname, ".replay-units.entry.ts");
const bundle = path.join(__dirname, ".replay-units.bundle.cjs");
fs.writeFileSync(
  entry,
  `export { parseGuide } from "../src/disclosure/guide";\n` +
    `export * from "../src/disclosure/unitBudget";\n` +
    `export * from "../src/disclosure/replayRecord";\n`,
);
esbuild.buildSync({ entryPoints: [entry], bundle: true, outfile: bundle, format: "cjs", platform: "node" });
const { parseGuide, measureUnit, overBudget, newTypeNames, shellPanics, unitOrderProblems, redGreenProblems, unbuiltSurvivors, isTestFile, testPlacement, UnitClock, jsonLine, RECORD_GITATTRIBUTES, recordedPauseDone } =
  require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

const HEAD = "# Replay: units\n\n## System Invariants\n\n- **Single writer:** one owner\n\n";

function step(id, fields, fence) {
  const body = Object.entries(fields)
    .map(([k, v]) => `**${k}:** ${v}`)
    .join("\n");
  return `### Step ${id}: s${id}\n\n${body}\n${fence ? `\n**Shows:**\n\n\`\`\`\n${fence}\n\`\`\`\n` : ""}\n`;
}

// ---------------------------------------------------------------------------
// Parse

test("parse: a phase's **Unit:** and **Module:** become a unit", () => {
  const g = parseGuide(
    HEAD + "## Phase 1: Tail contract\n\n**Unit:** contract\n**Module:** `src/tail.rs`\n\n" + step("1.1", { Action: "Modify", Symbol: "f", File: "src/tail.rs" }),
  );
  assert.deepStrictEqual(g.units, [{ phase: "Phase 1: Tail contract", line: 7, kind: "contract", module: "src/tail.rs", shells: "throw" }]);
});

test("parse: a phase with no **Unit:** declares no unit and still parses", () => {
  const g = parseGuide(HEAD + "## Phase 1: Old\n\n**Layer:** Core\n\n" + step("1.1", { Action: "Modify", Symbol: "f", File: "a.rs" }));
  assert.deepStrictEqual(g.units, []);
});

test("parse: an unknown unit kind fails loud", () => {
  assert.throws(
    () => parseGuide(HEAD + "## Phase 1: X\n\n**Unit:** sprint\n\n" + step("1.1", { Action: "Modify", Symbol: "f", File: "a.rs" })),
    /unknown \*\*Unit:\*\* "sprint"/,
  );
});

test("parse: Red and Green are name lists, backticks stripped", () => {
  const g = parseGuide(
    HEAD +
      "## Phase 1: X\n\n" +
      step("1.1", { Action: "Create", Symbol: "t", File: "a.rs", Red: "`walkthrough_admit`, admit_refuses_full" }) +
      step("1.2", { Action: "Modify", Symbol: "f", File: "a.rs", Green: "walkthrough_admit" }),
  );
  assert.deepStrictEqual(g.steps[0].red, ["walkthrough_admit", "admit_refuses_full"]);
  assert.deepStrictEqual(g.steps[1].green, ["walkthrough_admit"]);
  assert.deepStrictEqual(g.steps[0].green, []);
});

test("parse: a read step carries its file as the symbol, or its own fence", () => {
  const g = parseGuide(
    HEAD +
      "## Phase 1: X\n\n" +
      step("1.1", { Action: "Read", File: "src/owner.rs" }) +
      step("1.2", { Action: "Read", Symbol: "drive", File: "src/owner.rs" }) +
      step("1.3", { Action: "Read", Symbol: "loop" }, "fn loop() {}"),
  );
  assert.deepStrictEqual(
    g.steps.map((s) => [s.action, s.symbol, s.after]),
    [
      ["read", "src/owner.rs", undefined],
      ["read", "drive", undefined],
      ["read", "loop", "fn loop() {}"],
    ],
  );
});

test("parse: a comment step needs a file; its Shows fence is the stage table", () => {
  const g = parseGuide(HEAD + "## Phase 1: X\n\n" + step("1.1", { Action: "Comment", File: "src/tail.rs" }, "| stage | owner |"));
  assert.strictEqual(g.steps[0].symbol, "src/tail.rs");
  assert.strictEqual(g.steps[0].after, "| stage | owner |");
  assert.throws(() => parseGuide(HEAD + "## Phase 1: X\n\n" + step("1.1", { Action: "Comment" })), /no Before\/After fence and no \*\*File:\*\*/);
});

const RULE_CASES = [
  // id                          fields                                                          ruling or error
  ["two options, recommended", { Decision: "D-626", Options: "yes | no", Recommend: "Yes" }, { decision: "D-626", options: ["yes", "no"], recommend: "yes" }],
  ["variants, none recommended", { Decision: "`D-687`", Options: "A | B | park" }, { decision: "D-687", options: ["A", "B", "park"], recommend: undefined }],
  ["no decision id", { Options: "yes | no" }, /has no \*\*Decision:\*\*/],
  ["one option", { Decision: "D-1", Options: "yes" }, /at least two \*\*Options:\*\*/],
  ["repeated option", { Decision: "D-1", Options: "yes | YES" }, /repeats an option/],
  ["recommends an absent option", { Decision: "D-1", Options: "yes | no", Recommend: "maybe" }, /not one of its options/],
];
for (const [id, fields, want] of RULE_CASES) {
  test(`parse rule: ${id}`, () => {
    const md = HEAD + "## Phase 1: X\n\n" + step("1.1", { Action: "Rule", ...fields });
    if (want instanceof RegExp) return assert.throws(() => parseGuide(md), want);
    const s = parseGuide(md).steps[0];
    assert.deepStrictEqual(s.ruling, want);
    assert.strictEqual(s.symbol, want.decision);
  });
}

// ---------------------------------------------------------------------------
// Budget

const mk = (id, action, file, extra = {}) => ({ id, action, file, red: [], green: [], ...extra });
const cost = (s, lines = []) => ({ step: s, addedLines: lines });

test("budget: 25 steps fit, 26 do not; pause steps count as steps, not lines", () => {
  const steps = (n) => Array.from({ length: n }, (_, i) => cost(mk(`1.${i}`, "rule", "")));
  assert.deepStrictEqual(overBudget(measureUnit("P", undefined, steps(25))), []);
  assert.deepStrictEqual(overBudget(measureUnit("P", undefined, steps(26))), ["26 steps (max 25)"]);
  assert.strictEqual(measureUnit("P", undefined, [cost(mk("1.1", "read", "a.rs"), ["x"])]).typedLines, 0);
});

test("budget: 150 typed lines fit, 151 do not", () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `let x${i} = ${i};`);
  assert.deepStrictEqual(overBudget(measureUnit("P", undefined, [cost(mk("1.1", "modify", "a.rs"), lines(150))])), []);
  assert.deepStrictEqual(overBudget(measureUnit("P", undefined, [cost(mk("1.1", "modify", "a.rs"), lines(151))])), ["151 typed lines (max 150)"]);
});

test("budget: a fifth new type is refused and named", () => {
  const types = ["pub struct A {", "enum B {", "pub(crate) trait C {", "type D = u64;", "union E {"];
  const m = measureUnit("P", undefined, [cost(mk("1.1", "create-file", "src/a.rs"), types)]);
  assert.deepStrictEqual(m.newTypes, ["A", "B", "C", "D", "E"]);
  assert.deepStrictEqual(overBudget(m), ["5 new types: A, B, C, D, E (max 4)"]);
});

const TYPE_CASES = [
  // file           added line                                   names
  ["a.rs", "    type Output = u64;", []], // associated type, indented: not a new type
  ["a.rs", "pub struct Tail<T> {", ["Tail"]],
  ["a.cs", "public sealed record Ack(long Seq);", ["Ack"]],
  ["a.ts", "export interface Slot {", ["Slot"]],
  ["a.py", "class Cache:", ["Cache"]],
  ["a.toml", "struct = 1", []],
];
for (const [file, line, names] of TYPE_CASES) {
  test(`new types: ${file} ${JSON.stringify(line)}`, () => assert.deepStrictEqual(newTypeNames(file, [line]), names));
}

test("module: typed files outside **Module:** are listed, tests and pauses are not", () => {
  const m = measureUnit("P", "src/shard/tail", [
    cost(mk("1.1", "modify", "src/shard/tail.rs")),
    cost(mk("1.2", "modify", "src/shard/tail/slot.rs:4")),
    cost(mk("1.3", "modify", "tests/tail.rs")),
    cost(mk("1.4", "read", "src/shard/owner.rs")),
    cost(mk("1.5", "patch", "src/shard/mod.rs")),
  ]);
  assert.deepStrictEqual(m.outsideModule, ["src/shard/mod.rs"]);
});

test("test files: by directory or by name", () => {
  assert.deepStrictEqual(
    ["tests/tail.rs", "src/tail.test.ts", "test_tail.py", "src/tail.rs", "src/attest.rs"].map(isTestFile),
    [true, true, true, false, false],
  );
});

test("shells: each supported language's not-implemented marker is recognised", () => {
  const found = shellPanics([
    cost(mk("1.1", "create", "a.rs"), ["    todo!()", "    Err(Refusal::Unbuilt)"]),
    cost(mk("1.2", "create", "a.cs"), ["throw new NotImplementedException();"]),
    cost(mk("1.3", "read", "a.rs"), ["panic!(\"in a caller the human only reads\")"]),
    cost(mk("1.4", "create", "a.py"), ["        raise NotImplementedError"]),
    cost(mk("1.5", "create", "a.ts"), ['  throw new Error("not implemented");']),
    cost(mk("1.6", "create", "b.ts"), ['  throw new Error("cap reached");']),
  ]);
  assert.deepStrictEqual(found.map((f) => f.step), ["1.1", "1.2", "1.4", "1.5"]);
});

test("shells: **Shells:** no-throw on a phase is parsed; the default is throw", () => {
  const md =
    HEAD + "## Phase 1: A\n\n**Unit:** contract\n**Shells:** no-throw\n\n" + step("1.1", { Action: "Modify", Symbol: "f", File: "a.rs" }) +
    "## Phase 2: B\n\n**Unit:** internals\n\n" + step("2.1", { Action: "Modify", Symbol: "g", File: "a.rs" });
  const units = parseGuide(md).units;
  assert.deepStrictEqual(units.map((u) => u.shells), ["no-throw", "throw"]);
});

test("placement: a tests-only phase and an untested code phase are told apart", () => {
  assert.deepStrictEqual(testPlacement([mk("1.1", "create", "tests/tail.rs"), mk("1.2", "modify", "tests/tail.rs")]), { testsOnly: true, untested: false });
  assert.deepStrictEqual(testPlacement([mk("1.1", "create", "src/tail.rs"), mk("1.2", "modify", "src/tail.rs")]), { testsOnly: false, untested: true });
  assert.deepStrictEqual(testPlacement([mk("1.1", "create", "src/tail.rs"), mk("1.2", "create", "tests/tail.rs")]), { testsOnly: false, untested: false });
  assert.deepStrictEqual(testPlacement([mk("1.1", "modify", "src/tail.rs", { green: ["walkthrough"] })]), { testsOnly: false, untested: false });
  assert.deepStrictEqual(testPlacement([mk("1.1", "rule", ""), mk("1.2", "create-file", "README.md")]), { testsOnly: false, untested: false });
});

// ---------------------------------------------------------------------------
// Order

const unit = (kind) => ({ phase: "P", line: 1, kind, module: undefined, shells: "throw" });

test("contract: red tests then the caller view is clean", () => {
  const v = unitOrderProblems(unit("contract"), [
    mk("1.1", "create", "a.rs"),
    mk("1.2", "create", "a.rs", { red: ["walkthrough"] }),
    mk("1.3", "read", "owner.rs"),
  ]);
  assert.deepStrictEqual(v, { errors: [], warnings: [] });
});

test("contract: no red test is refused; a body turning green is refused", () => {
  const v = unitOrderProblems(unit("contract"), [mk("1.1", "create", "a.rs"), mk("1.2", "modify", "a.rs", { green: ["t"] })]);
  assert.strictEqual(v.errors.length, 2);
  assert.match(v.errors[0], /names no red test/);
  assert.match(v.errors[1], /step 1.2 turns tests green inside a contract unit/);
  assert.match(v.warnings[0], /no read step/);
});

test("internals: a body that names no green test warns", () => {
  const v = unitOrderProblems(unit("internals"), [
    mk("2.1", "modify", "a.rs", { green: ["t"] }),
    mk("2.2", "modify", "a.rs"),
    mk("2.3", "patch", "a.rs"),
  ]);
  assert.deepStrictEqual(v.errors, []);
  assert.deepStrictEqual(v.warnings, ["step 2.2 names no test it turns green (`**Green:**`)"]);
});

test("closing: grill, debt, walkthrough, comments, contract page is clean", () => {
  const v = unitOrderProblems(unit("closing"), [
    mk("3.1", "rule", ""),
    mk("3.2", "read", "tests/edge.rs"),
    mk("3.3", "modify", "src/open.rs"),
    mk("3.4", "create", "tests/open.rs"),
    mk("3.5", "comment", "src/open.rs"),
    mk("3.6", "create-file", "docs/contracts/open.md"),
  ]);
  assert.deepStrictEqual(v, { errors: [], warnings: [] });
});

test("closing: a rule after typed debt and a comment before it are refused", () => {
  const v = unitOrderProblems(unit("closing"), [
    mk("3.1", "comment", "src/open.rs"),
    mk("3.2", "modify", "src/open.rs"),
    mk("3.3", "rule", ""),
  ]);
  assert.deepStrictEqual(v.errors, [
    "closing unit opens with no grill: a rule or read step before the first typed step",
    "rule step 3.3 comes after typed step 3.2: the grill opens the unit",
    "comment step 3.1 comes before typed step 3.2: comments go on the code as it ends",
  ]);
  assert.match(v.warnings[0], /not a contract page/);
});

test("closing: a grill of read steps only is enough", () => {
  const v = unitOrderProblems(unit("closing"), [
    mk("3.1", "read", "tests/edge.rs"),
    mk("3.2", "modify", "src/open.rs"),
    mk("3.3", "comment", "src/open.rs"),
    mk("3.4", "read", "docs/contracts/open.md"),
  ]);
  assert.deepStrictEqual(v, { errors: [], warnings: [] });
});

test("closing: no grill and no comment are both refused", () => {
  const v = unitOrderProblems(unit("closing"), [mk("3.1", "modify", "a.rs"), mk("3.2", "read", "c.md")]);
  assert.strictEqual(v.errors.length, 2);
});

test("red/green: a green with no red warns; a red never greened and a double green are errors", () => {
  const v = redGreenProblems([
    mk("1.1", "create", "a.rs", { red: ["a", "b"] }),
    mk("2.1", "modify", "a.rs", { green: ["a", "z"] }),
    mk("2.2", "modify", "a.rs", { green: ["a"] }),
  ]);
  assert.deepStrictEqual(v.errors, [
    "test `a` turned green twice (again at step 2.2)",
    "test `b` (red at step 1.1) never turns green: Steps ends red",
  ]);
  assert.deepStrictEqual(v.warnings, ["step 2.1 turns `z` green, but no earlier step in this guide marks it red"]);
});

test("unbuilt: a surviving `Unbuilt` is named by file, a word inside another is not", () => {
  const files = new Map([
    ["src/a.rs", "enum R { Full, Unbuilt }"],
    ["src/b.rs", "enum R { Full, NotUnbuiltYet }"],
  ]);
  assert.deepStrictEqual(unbuiltSurvivors(files), ["src/a.rs"]);
});

// ---------------------------------------------------------------------------
// Record

test("clock: start on entry, stop on leaving, one start per sitting in a unit", () => {
  let t = Date.UTC(2026, 9, 28, 9, 0, 0);
  const clock = new UnitClock("units", () => t);
  const progress = (u) => ({ steps: u === "P1" ? 20 : 18, done: 3 });
  assert.deepStrictEqual(clock.enter("P1", progress), [{ event: "start", unit: "P1", guide: "units", at: "2026-10-28T09:00:00.000Z" }]);
  assert.deepStrictEqual(clock.enter("P1", progress), []);
  t += 40 * 60 * 1000;
  const moved = clock.enter("P2", progress);
  assert.deepStrictEqual(moved, [
    { event: "stop", unit: "P1", guide: "units", at: "2026-10-28T09:40:00.000Z", steps: 20, done: 3, reason: "left-unit" },
    { event: "start", unit: "P2", guide: "units", at: "2026-10-28T09:40:00.000Z" },
  ]);
  assert.strictEqual(clock.leave("session-ended", progress)[0].reason, "session-ended");
  assert.deepStrictEqual(clock.leave("session-ended", progress), []);
  assert.strictEqual(clock.current, undefined);
});

test("record: one JSON object per line, parseable back", () => {
  const ruling = { decision: "D-626", choice: "yes", options: ["yes", "no"], recommended: "yes", guide: "g", unit: "Phase 1", step: "1.2", at: "2026-10-28T09:00:00.000Z" };
  const line = jsonLine(ruling);
  assert.ok(line.endsWith("\n") && !line.slice(0, -1).includes("\n"));
  assert.deepStrictEqual(JSON.parse(line), ruling);
  assert.deepStrictEqual(JSON.parse(jsonLine(ruling, "alex")), { ...ruling, by: "alex" });
});

test("record: rule and comment steps done from the record; reads behind them; others' picks ignored", () => {
  const steps = [
    { id: "1.1", action: "rule", ruling: { decision: "D-1" } },
    { id: "1.2", action: "rule", ruling: { decision: "D-2" } },
    { id: "1.3", action: "read" },
    { id: "1.4", action: "create" },
    { id: "1.5", action: "comment" },
  ];
  const r = (step, decision, by) => jsonLine({ decision, choice: "yes", options: ["yes", "no"], recommended: null, guide: "g", unit: null, step, at: "t" }, by);
  const rulings = r("1.1", "D-1", "me") + r("1.2", "D-2", "sam") + "torn {\n";
  assert.deepStrictEqual(recordedPauseDone(steps, "g", "me", rulings, undefined, []), [0]);
  const both = rulings + r("1.2", "D-2", "me");
  assert.deepStrictEqual(recordedPauseDone(steps, "g", "me", both, undefined, []), [0, 1]);
  const units = jsonLine({ event: "comment", unit: "u", guide: "g", at: "t", step: "1.5", file: "a.rs", changed: true }, "me");
  assert.deepStrictEqual(recordedPauseDone(steps, "g", "me", both, units, [3]), [0, 1, 2, 4]);
  assert.deepStrictEqual(recordedPauseDone(steps, "other guide", "me", both, units, []), []);
});

test("record: two branches' lines union-merge cleanly in git, in any order", () => {
  const { execFileSync } = require("child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "replay-union-"));
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitattributes"), RECORD_GITATTRIBUTES);
  const line = (d, by, at) => jsonLine({ decision: d, choice: "yes", options: ["yes", "no"], recommended: null, guide: "g", unit: null, step: "1.1", at }, by);
  fs.writeFileSync(path.join(repo, "rulings.jsonl"), line("D-1", "alex", "2026-10-28T09:00:00Z"));
  git("add", "-A"); git("commit", "-qm", "base");
  git("checkout", "-qb", "a");
  fs.appendFileSync(path.join(repo, "rulings.jsonl"), line("D-2", "alex", "2026-10-28T10:00:00Z"));
  git("commit", "-qam", "a");
  git("checkout", "-q", "main");
  fs.appendFileSync(path.join(repo, "rulings.jsonl"), line("D-3", "sam", "2026-10-28T09:30:00Z"));
  git("commit", "-qam", "main");
  git("merge", "-q", "--no-edit", "a");
  const lines = fs.readFileSync(path.join(repo, "rulings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => l.decision).sort(), ["D-1", "D-2", "D-3"]);
  assert.deepStrictEqual(lines.map((l) => l.by).sort(), ["alex", "alex", "sam"]);
});

// ---------------------------------------------------------------------------
// The validator, end to end on a two-unit outside-in guide over a tiny Rust tree.

const VALIDATOR = path.join(__dirname, "../scripts/validate-guide.js");

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-units-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const TARGET = { "src/tail.rs": "//! Tail cache.\n" };
const ADMIT_DONE = "pub fn admit(cache: &mut Cache, v: u64) -> Result<(), Refusal> {\n    cache.slots.push(v);\n    Ok(())\n}";
const SANDBOX = {
  "src/tail.rs":
    "//! Tail cache.\n\npub enum Refusal {\n    Full,\n}\n\npub struct Cache {\n    slots: Vec<u64>,\n}\n\n" +
    ADMIT_DONE +
    "\n\nfn walkthrough_admit() {\n    let mut c = Cache { slots: Vec::new() };\n    assert!(admit(&mut c, 7).is_ok());\n}\n",
  "src/owner.rs": "pub fn drive(c: &mut Cache) {\n    let _ = admit(c, 1);\n}\n",
};

function guide(shell) {
  return (
    HEAD +
    "## Phase 1: Tail\n\n**Unit:** component\n**Module:** src/tail.rs\n\n" +
    step("1.1", { Action: "Create", Symbol: "Refusal", File: "src/tail.rs", Retrospective: "none" }) +
    step("1.2", { Action: "Create", Symbol: "Cache", File: "src/tail.rs", Retrospective: "none" }) +
    `### Step 1.3: admit shell\n\n**Action:** Create\n**Symbol:** admit\n**File:** src/tail.rs\n**Retrospective:** none\n\n**After:**\n\n\`\`\`rust\npub fn admit(cache: &mut Cache, v: u64) -> Result<(), Refusal> {\n    ${shell}\n}\n\`\`\`\n\n` +
    step("1.4", { Action: "Create", Symbol: "walkthrough_admit", File: "src/tail.rs", Red: "walkthrough_admit", Retrospective: "none" }) +
    step("1.5", { Action: "Read", Symbol: "drive", File: "src/owner.rs" }) +
    step("1.6", { Action: "Modify", Symbol: "admit", File: "src/tail.rs", Green: "walkthrough_admit", Retrospective: "none" }) +
    step("1.7", { Action: "Rule", Decision: "D-626", Options: "yes | no", Recommend: "yes", Why: "Admit refuses when full." }) +
    step("1.8", { Action: "Comment", File: "src/tail.rs" }, "| stage | owner |")
  );
}

function validate(md) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-units-guide-"));
  const g = path.join(dir, "guide.md");
  fs.writeFileSync(g, md);
  const r = spawnSync(process.execPath, [VALIDATOR, g, tree(TARGET), tree(SANDBOX)], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("validator: an outside-in component that ends green passes", () => {
  const r = validate(guide("Err(Refusal::Full)"));
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /ok\s+Phase 1: Tail \(component\) — 8 steps, \d+ typed lines, 2 new types/);
  assert.match(r.out, /units: 1 checked, 0 refused/);
});

test("validator: a phase that ends red is refused", () => {
  const split = guide("Err(Refusal::Full)").replace(
    "### Step 1.6:",
    "## Phase 2: Tail bodies\n\n**Unit:** component\n**Module:** src/tail.rs\n\n### Step 1.6:",
  );
  const r = validate(split);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /`walkthrough_admit` goes red in Phase 1: Tail and green only in Phase 2: Tail bodies: a phase ends green/);
});

test("validator: a todo!() shell is fine by default and refused in a no-throw unit", () => {
  const plain = validate(guide("todo!()"));
  assert.doesNotMatch(plain.out, /shell panics/);
  const strict = validate(guide("todo!()").replace("**Unit:** component\n", "**Unit:** component\n**Shells:** no-throw\n"));
  assert.strictEqual(strict.code, 1, strict.out);
  assert.match(strict.out, /step 1.3 shell panics in a no-throw unit: `todo!\(\)`/);
});

test("validator: an `Unbuilt` that survives the last step is refused", () => {
  const md = guide("Err(Refusal::Unbuilt)").replace(step("1.6", { Action: "Modify", Symbol: "admit", File: "src/tail.rs", Green: "walkthrough_admit", Retrospective: "none" }), "");
  const r = validate(md);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /src\/tail.rs — still names `Unbuilt`/);
});

test("validator: a unit over budget is refused by name", () => {
  const rules = Array.from({ length: 26 }, (_, i) => step(`9.${i + 1}`, { Action: "Rule", Decision: `D-${i}`, Options: "yes | no" })).join("");
  const r = validate(guide("Err(Refusal::Full)") + "## Phase 9: Grill\n\n" + rules);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+Phase 9: Grill — over budget: 26 steps \(max 25\)\. Split it/);
  assert.match(r.out, /units refused: Phase 9: Grill/);
});
