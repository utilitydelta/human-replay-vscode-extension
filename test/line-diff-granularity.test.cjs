// Blind black-box contract oracle for lineDiffSteps(oldText, newText).
//
// Written from the CONTRACT only — the implementation (src/disclosure/lineDiff.ts)
// was NOT read. These prove the surface the human replay engine leans on:
//   1. Byte-exact reconstruction — applying the returned edit script to `old`
//      rebuilds `new` exactly; every hunk's bytes come from the real files.
//   2. Granularity — shared common line runs are NOT swallowed into one giant
//      replace; scattered tiny edits stay tiny. (Expected to FAIL today.)
//   3. Well-formed edit script — ordered, non-overlapping, in-bounds, and the
//      kind matches the hunk shape.
//   4. No pathological blowup on large inputs.
//
// Run: node --test test/line-diff-granularity.test.cjs

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const esbuild = require("esbuild");

// --- Harness: bundle the pure function headless (scaffolding copied from
// test/line-patch.test.cjs; behavior NOT inferred from it). ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "line-diff-granularity-"));
const entry = path.join(tmpDir, "entry.ts");
const bundle = path.join(tmpDir, "bundle.cjs");
fs.writeFileSync(
  entry,
  `export { lineDiffSteps } from "${path.join(__dirname, "..", "src", "disclosure", "lineDiff").replace(/\\/g, "/")}";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: [
    "tree-sitter",
    "tree-sitter-rust",
    "tree-sitter-c-sharp",
    "tree-sitter-typescript",
    "tree-sitter-python",
    "@tree-sitter-grammars/tree-sitter-markdown",
    "tree-sitter-html",
    "tree-sitter-css",
  ],
});
const { lineDiffSteps } = require(bundle);
test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Contract-level helpers (no knowledge of internals) ---

// Apply the edit script back-to-front so each step's [start,end) offsets into
// `old` stay valid as later edits are already placed. Steps are contractually
// ordered ascending and non-overlapping, so reverse application reconstructs.
function applySteps(oldText, steps) {
  let out = oldText;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
  }
  return out;
}

function nlCount(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// Total lines the script touches: removed lines + inserted lines across hunks.
function changedLineTotal(steps) {
  let n = 0;
  for (const s of steps) n += nlCount(s.originalText) + nlCount(s.replacement);
  return n;
}

// Largest number of old lines any single hunk claims to replace/delete.
function maxHunkSpanLines(steps) {
  let m = 0;
  for (const s of steps) m = Math.max(m, nlCount(s.originalText));
  return m;
}

// The well-formedness contract, asserted for every produced script.
function assertWellFormed(oldText, steps) {
  let prevEnd = 0;
  for (const s of steps) {
    assert.ok(Number.isInteger(s.start) && Number.isInteger(s.end), "start/end are integers");
    assert.ok(s.start >= 0 && s.end <= oldText.length, "range within old");
    assert.ok(s.start <= s.end, "start <= end");
    assert.ok(s.start >= prevEnd, "steps are ascending and non-overlapping");
    prevEnd = s.end;
    assert.strictEqual(oldText.slice(s.start, s.end), s.originalText, "originalText is a byte-exact old slice");
    if (s.kind === "insert") {
      assert.strictEqual(s.originalText, "", "insert has empty originalText");
      assert.notStrictEqual(s.replacement, "", "insert has non-empty replacement");
    } else if (s.kind === "delete") {
      assert.strictEqual(s.replacement, "", "delete has empty replacement");
      assert.notStrictEqual(s.originalText, "", "delete has non-empty originalText");
    } else if (s.kind === "replace") {
      assert.notStrictEqual(s.originalText, "", "replace has non-empty originalText");
      assert.notStrictEqual(s.replacement, "", "replace has non-empty replacement");
    } else {
      assert.fail(`unknown kind: ${s.kind}`);
    }
    assert.strictEqual(typeof s.singleLine, "boolean", "singleLine is a boolean");
  }
}

// ============================================================
// Invariant 1: byte-exact reconstruction (ground truth)
// ============================================================
const RECONSTRUCT_CASES = [
  { name: "empty -> text", old: "", new: "hello\nworld\n" },
  { name: "text -> empty", old: "hello\nworld\n", new: "" },
  { name: "identical (expect zero steps)", old: "a\nb\nc\n", new: "a\nb\nc\n", zeroSteps: true },
  { name: "single-line change", old: "a\nb\nc\n", new: "a\nB\nc\n" },
  { name: "multi-line insert", old: "a\nb\n", new: "a\nx\ny\nz\nb\n" },
  { name: "multi-line delete", old: "a\nx\ny\nz\nb\n", new: "a\nb\n" },
  {
    name: "scattered edits",
    old: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
    new: "1\nTWO\n3\n4\n5\nSIX\n7\n8\n9\nTEN\n",
  },
  { name: "CRLF line endings", old: "a\r\nb\r\nc\r\n", new: "a\r\nB\r\ninserted\r\nc\r\n" },
  { name: "no trailing newline", old: "a\nb\nc", new: "a\nB\nc" },
  { name: "trailing-newline toggle", old: "a\nb\n", new: "a\nb" },
];

for (const c of RECONSTRUCT_CASES) {
  test(`inv1 byte-exact reconstruction — ${c.name}`, () => {
    const steps = lineDiffSteps(c.old, c.new);
    if (c.zeroSteps) assert.deepStrictEqual(steps, [], "identical inputs yield zero steps");
    for (const s of steps) {
      assert.strictEqual(c.old.slice(s.start, s.end), s.originalText, "originalText is a byte-exact old slice");
      assert.ok(s.replacement === "" || c.new.includes(s.replacement), "replacement is real new bytes");
    }
    assert.strictEqual(applySteps(c.old, steps), c.new, "script rebuilds new byte-exact");
    assertWellFormed(c.old, steps);
  });
}

// ============================================================
// Invariant 3: well-formed edit script
// ============================================================
test("inv3 identical inputs produce zero steps", () => {
  assert.deepStrictEqual(lineDiffSteps("x\ny\nz\n", "x\ny\nz\n"), []);
});

test("inv3 well-formed across a spread of shapes", () => {
  for (const c of RECONSTRUCT_CASES) {
    const steps = lineDiffSteps(c.old, c.new);
    assertWellFormed(c.old, steps);
  }
});

// ============================================================
// Invariant 2: granularity / no whole-file collapse (KEY — expected to FAIL)
// ============================================================
function lines(n, make) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(make(i));
  return out;
}

const GRANULARITY_CASES = [
  {
    name: "3000 identical lines, 3 scattered one-line edits (50/1500/2950)",
    build() {
      const base = lines(3000, () => "same line");
      const oldText = base.join("\n") + "\n";
      const nw = base.slice();
      nw[50] = "EDITED AT FIFTY";
      nw[1500] = "EDITED AT FIFTEEN HUNDRED";
      nw[2950] = "EDITED NEAR THE BOTTOM";
      const newText = nw.join("\n") + "\n";
      return { oldText, newText };
    },
    maxChanged: 50,
    maxSpan: 100,
  },
  {
    name: "5000 lines, ~20 scattered single-line edits",
    build() {
      const base = lines(5000, (i) => `line ${i}`);
      const oldText = base.join("\n") + "\n";
      const nw = base.slice();
      for (let k = 0; k < 20; k++) {
        const idx = 137 + k * 233; // scattered, far apart, all < 5000
        nw[idx] = `line ${idx} CHANGED`;
      }
      const newText = nw.join("\n") + "\n";
      return { oldText, newText };
    },
    maxChanged: 200,
    maxSpan: 100,
  },
  {
    name: "wide-span tiny-change: 1700 lines, edits at 120 and 1370 only",
    build() {
      const base = lines(1700, (i) => `content row ${i}`);
      const oldText = base.join("\n") + "\n";
      const nw = base.slice();
      nw[120] = "content row 120 CHANGED";
      nw[1370] = "content row 1370 CHANGED";
      const newText = nw.join("\n") + "\n";
      return { oldText, newText };
    },
    maxChanged: 40,
    maxSpan: 100,
  },
];

for (const c of GRANULARITY_CASES) {
  test(`inv2 localized hunks, no whole-file collapse — ${c.name}`, () => {
    const { oldText, newText } = c.build();
    const steps = lineDiffSteps(oldText, newText);
    // Ground truth still holds regardless of granularity.
    assert.strictEqual(applySteps(oldText, steps), newText, "script rebuilds new byte-exact");
    assertWellFormed(oldText, steps);
    // The key property: the unchanged runs must not be swallowed.
    const changed = changedLineTotal(steps);
    const span = maxHunkSpanLines(steps);
    assert.ok(
      changed < c.maxChanged,
      `changed-line total must stay small (got ${changed}, expected < ${c.maxChanged})`,
    );
    assert.ok(
      span < c.maxSpan,
      `no single hunk may span the unchanged middle (max span ${span} lines, expected < ${c.maxSpan})`,
    );
  });
}

// ============================================================
// Invariant 4: no pathological blowup on large inputs
// ============================================================
test("inv4 large input (5000 lines, ~20 edits) returns granular steps promptly", () => {
  const base = lines(5000, (i) => `row ${i}`);
  const oldText = base.join("\n") + "\n";
  const nw = base.slice();
  for (let k = 0; k < 20; k++) nw[100 + k * 240] = `row ${100 + k * 240} EDIT`;
  const newText = nw.join("\n") + "\n";

  const t0 = Date.now();
  const steps = lineDiffSteps(oldText, newText);
  const ms = Date.now() - t0;

  assert.strictEqual(applySteps(oldText, steps), newText, "script rebuilds new byte-exact");
  assertWellFormed(oldText, steps);
  assert.ok(ms < 10000, `must complete without hanging (took ${ms}ms)`);
  // Granular even at size: must not collapse to one whole-file replace.
  assert.ok(maxHunkSpanLines(steps) < 100, "large input still yields bounded hunks");
});
