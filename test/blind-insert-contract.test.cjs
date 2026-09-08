// Blind contract oracle for extraction + pure-insert replay.
//
// Written from the contract, not from the implementation. What it pins:
//
//   - extractSymbol is a byte-exact slice of the file, starts at the symbol's
//     first visible byte, and is INDENTATION-SYMMETRIC: trivia above the item
//     (doc comment, attribute, decorator) must not change the symbol's leading
//     whitespace;
//   - the controller's exact sequential loop (resolve -> splice -> selfDelta ->
//     ledger) rebuilds `after` byte for byte on a clean buffer, for the shapes
//     that break in the field: a pure insert at the END of a symbol, one
//     immediately ABOVE a blank line, one at the very START of a symbol, and a
//     symbol whose trivia exists on one side only;
//   - ambiguity does not become silence: with identical repeated blocks or a
//     repeated context, a clean-buffer replay is still byte-exact;
//   - fail-loud holds under divergence: with a foreign edit booked in the
//     ledger, a pure insert lands at its TRUE spot or resolveStep returns null.
//     Silently wrong bytes is the severe failure this file hunts.
//
// Run: node --test test/blind-insert-contract.test.cjs

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const entry = path.join(__dirname, ".blind-insert.entry.ts");
const bundle = path.join(__dirname, ".blind-insert.bundle.cjs");
fs.writeFileSync(
  entry,
  `export { extractSymbol } from "../src/disclosure/resume";\n` +
    `export { buildReplaySteps } from "../src/disclosure/sequence";\n` +
    `export { resolveStep } from "../src/disclosure/replay";\n` +
    `export { parseRoot } from "../src/disclosure/diff";\n` +
    `export { RUST, CSHARP, TYPESCRIPT, TSX, PYTHON, MARKDOWN, HTML, CSS } from "../src/disclosure/language";\n`,
);
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: "cjs",
  platform: "node",
  external: ["tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
});
const { extractSymbol, buildReplaySteps, resolveStep, parseRoot, RUST, CSHARP, TYPESCRIPT, PYTHON, MARKDOWN, CSS } = require(bundle);
test.after(() => {
  fs.rmSync(bundle, { force: true });
  fs.rmSync(entry, { force: true });
});

// --- the controller's loop, verbatim ---------------------------------------
// For each step: resolve against the CURRENT buffer, splice in the
// replacement, add the length delta to selfDelta, book the change on the
// ledger. `events[i]` runs before step i resolves and returns foreign splices
// applied in then-current coordinates and booked as not-self.

function replay(buffer, steps, spec, events = {}) {
  let buf = buffer;
  let selfDelta = 0;
  const ledger = [];
  for (const [i, st] of steps.entries()) {
    for (const { offset, del, text } of events[i]?.(buf, ledger) ?? []) {
      buf = buf.slice(0, offset) + text + buf.slice(offset + del);
      ledger.push({ offset, rangeLength: del, textLength: text.length });
    }
    const r = resolveStep(buf, parseRoot(buf, spec), st, selfDelta, ledger);
    if (!r) return { collidedAt: i, buf };
    buf = buf.slice(0, r[0]) + st.replacement + buf.slice(r[1]);
    selfDelta += st.replacement.length - (r[1] - r[0]);
    ledger.push({ offset: r[0], rangeLength: r[1] - r[0], textLength: st.replacement.length, self: true });
  }
  return { buf };
}

const ledgerDelta = (ledger) => ledger.reduce((d, e) => d + e.textLength - e.rangeLength, 0);
const leading = (s) => (s.match(/^[ \t]*/) || [""])[0];
const firstInsert = (steps) => steps.findIndex((s) => s.originalText === "");

function pair(c) {
  const before = extractSymbol(c.file, c.symbol, c.spec);
  const after = extractSymbol(c.fileAfter, c.symbol, c.spec);
  assert.ok(before !== undefined, `corpus: ${c.symbol} must extract from the target side`);
  assert.ok(after !== undefined, `corpus: ${c.symbol} must extract from the sandbox side`);
  assert.notStrictEqual(before, after, "corpus must be a real change");
  return [before, after];
}

// --- corpora ----------------------------------------------------------------
// Realistic-shaped files: nesting, doc comments, attributes, decorators,
// blank-line groups. Each case names the field shape it stands for.

const RS_FILE = (add) => `use std::fmt;

pub struct Ledger {
    total: i64,
    hits: i64,
}

impl Ledger {
    pub fn new() -> Self {
        Ledger { total: 0, hits: 0 }
    }

${add}

    pub fn reset(&mut self) {
        self.total = 0;
    }
}

impl fmt::Debug for Ledger {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Ledger({})", self.total)
    }
}
`;
const RS_ADD_PLAIN = `    pub fn add(&mut self, delta: i64) -> i64 {
        if delta > 0 {
            self.total += delta;
        }
        self.total
    }`;
const RS_ADD_DOC = `    /// Fold a positive delta into the running total.
    #[inline]
` + RS_ADD_PLAIN;

const RS_TOP_FILE = (fn) => `use std::fmt;

pub struct Ledger {
    pub total: i64,
    pub hits: i64,
}

${fn}

pub fn reset(l: &mut Ledger) {
    l.total = 0;
}
`;
const RS_TOP_PLAIN = `pub fn add(l: &mut Ledger, delta: i64) -> i64 {
    if delta > 0 {
        l.total += delta;
    }
    l.total
}`;
const RS_TOP_MID = `pub fn add(l: &mut Ledger, delta: i64) -> i64 {
    if delta > 0 {
        l.total += delta;
        l.hits += 1;
    }
    l.total
}`;
const RS_TOP_BLOCKS = `pub fn add(l: &mut Ledger, delta: i64) -> i64 {
    l.hits += 1;
    l.total += delta;

    l.hits += 1;
    l.total += delta;

    l.hits += 1;
    l.total += delta;

    l.total
}`;
const RS_TOP_BLOCKS_AFTER = `pub fn add(l: &mut Ledger, delta: i64) -> i64 {
    l.hits += 1;
    l.total += delta;

    l.hits += 1;
    l.total += delta;

    l.hits += 2;
    l.total -= delta;

    l.hits += 1;
    l.total += delta;

    l.total
}`;

const TS_FILE = (add) => `import { xs } from "./xs";

export class Ledger {
  private total = 0;

  constructor() {
    this.total = 0;
  }

${add}

  reset(): void {
    this.total = 0;
  }
}
`;
const TS_ADD_PLAIN = `  add(delta: number): number {
    const start = this.total;
    for (const x of xs) {
      this.total += x;
    }
    return this.total - start;
  }`;
const TS_ADD_DOC = `  /** Fold the deltas into the running total. */
` + TS_ADD_PLAIN;

const TS_TOP_FILE = (fn) => `import { xs } from "./xs";

${fn}

export const NAME = "ledger";
`;
const TS_TOP_PLAIN = `export function total(a: number): number {
  let out = a;
  for (const x of xs) {
    out += x;
  }
  return out;
}`;
const TS_TOP_DOC = `/** Sum the xs onto a. */
` + TS_TOP_PLAIN;
const TS_TOP_REPEAT = `export function total(a: number): number {
  let out = a;
  out += 1;
  out += 1;
  out += 1;
  return out;
}`;
const TS_TOP_REPEAT_AFTER = `export function total(a: number): number {
  let out = a;
  out += 1;
  out += 1;
  out += 7;
  out += 1;
  return out;
}`;

const PY_FILE = (add) => `import math


class Ledger:
    """A running total."""

    def __init__(self):
        self.total = 0

${add}

    def reset(self):
        self.total = 0
`;
const PY_ADD_PLAIN = `    def add(self, delta):
        """Add a positive delta."""
        if delta > 0:
            self.total += delta`;
const PY_ADD_DOC = `    # accumulate helper
    @retry(times=3)
` + PY_ADD_PLAIN;

const PY_TOP_FILE = (fn) => `import math

${fn}


def reset(state):
    state.total = 0
`;
const PY_TOP_PLAIN = `def add(state, delta):
    """Add a positive delta."""
    if delta > 0:
        state.total += delta`;
const PY_TOP_APPENDED = PY_TOP_PLAIN + `
    state.log(delta)`;

const CS_FILE = (add) => `using System;

namespace Demo;

public class Ledger
{
    private int _total;

${add}

    public void Reset()
    {
        _total = 0;
    }
}
`;
const CS_ADD_PLAIN = `    public int Add(int delta)
    {
        if (delta > 0)
        {
            _total += delta;
        }
        return _total;
    }`;
const CS_ADD_DOC = `    /// <summary>Accumulates positives.</summary>
    [Obsolete("use AddChecked")]
` + CS_ADD_PLAIN;

const CSS_FILE = (panel) => `:root {
  --gap: 8px;
}

.ledger-card {
  color: red;
}

@media (max-width: 600px) {
${panel}

  .ledger-tile {
    color: blue;
  }
}
`;
const CSS_PANEL_PLAIN = `  .ledger-panel {
    display: none;
    padding: var(--gap);
  }`;
const CSS_PANEL_DOC = `  /* hide the panel on phones */
` + CSS_PANEL_PLAIN;
const CSS_PANEL_APPENDED = `  .ledger-panel {
    display: none;
    padding: var(--gap);
    margin: 0;
  }`;

const MD_FILE = (section) => `# Guide

Intro paragraph for the guide.

${section}## Usage

Run the thing.
`;
const MD_SETUP = `## Setup

Install the runtime.

Then configure the sandbox with the defaults.

`;
const MD_SETUP_AFTER = `## Setup

Install the runtime.

Then configure the sandbox with the defaults.

Finally, open the target repo before you start a replay.

`;
const MD_MAP = `## Subsystem map

| part | role |
| --- | --- |
| walk | disclosure |
| diff | edit-aware |

The map is the fastest way into the engine.

`;
const MD_MAP_AFTER = `## Subsystem map

| part | role |
| --- | --- |
| walk | disclosure |
| diff | edit-aware |
| proof | ratification |

The map is the fastest way into the engine.

`;
const MD_RULES = `## Rules

Keep the buffer honest.

Keep the buffer honest.

Keep the buffer honest.

`;
const MD_RULES_AFTER = `## Rules

Keep the buffer honest.

Keep the buffer honest.

Never guess an offset.

Keep the buffer honest.

`;

// --- symmetry: trivia above an item must not move its leading whitespace ----
// Each case is the SAME nested symbol with and without its attached trivia.

const SYMMETRY = [
  { name: "rust nested method", spec: RUST, symbol: "add", plain: RS_FILE(RS_ADD_PLAIN), trivia: RS_FILE(RS_ADD_DOC), triviaBytes: "/// Fold a positive" },
  { name: "typescript nested method", spec: TYPESCRIPT, symbol: "add", plain: TS_FILE(TS_ADD_PLAIN), trivia: TS_FILE(TS_ADD_DOC), triviaBytes: "/** Fold the deltas" },
  { name: "python nested method", spec: PYTHON, symbol: "add", plain: PY_FILE(PY_ADD_PLAIN), trivia: PY_FILE(PY_ADD_DOC), triviaBytes: "# accumulate helper" },
  { name: "csharp nested method", spec: CSHARP, symbol: "Add", plain: CS_FILE(CS_ADD_PLAIN), trivia: CS_FILE(CS_ADD_DOC), triviaBytes: "/// <summary>" },
  { name: "css nested rule", spec: CSS, symbol: ".ledger-panel", plain: CSS_FILE(CSS_PANEL_PLAIN), trivia: CSS_FILE(CSS_PANEL_DOC), triviaBytes: "/* hide the panel" },
];

for (const c of SYMMETRY) {
  test(`${c.name}: extraction is a byte-exact slice of the file, both sides`, () => {
    for (const [side, file] of [["plain", c.plain], ["trivia", c.trivia]]) {
      const got = extractSymbol(file, c.symbol, c.spec);
      assert.ok(got !== undefined, `${side}: symbol must resolve`);
      assert.ok(file.includes(got), `${side}: extraction must be a slice of the file`);
    }
  });

  test(`${c.name}: the symbol starts at its first visible byte`, () => {
    for (const [side, file] of [["plain", c.plain], ["trivia", c.trivia]]) {
      const got = extractSymbol(file, c.symbol, c.spec);
      assert.strictEqual(
        leading(got),
        "",
        `${side}: symbol must start at its first visible byte, got ${JSON.stringify(got.slice(0, 40))}`,
      );
    }
  });

  test(`${c.name}: trivia above the item does not change the symbol's leading whitespace`, () => {
    const plain = extractSymbol(c.plain, c.symbol, c.spec);
    const trivia = extractSymbol(c.trivia, c.symbol, c.spec);
    assert.ok(trivia.includes(c.triviaBytes), "the trivia side must carry its attached bytes");
    assert.strictEqual(
      leading(trivia),
      leading(plain),
      `indentation asymmetry: with-trivia leads ${JSON.stringify(leading(trivia))}, without-trivia leads ${JSON.stringify(leading(plain))}`,
    );
  });

  test(`${c.name}: adding the trivia replays byte-exact (insert at the very start)`, () => {
    const [before, after] = pair({ spec: c.spec, symbol: c.symbol, file: c.plain, fileAfter: c.trivia });
    const steps = buildReplaySteps(before, after, c.spec);
    const { buf, collidedAt } = replay(before, steps, c.spec);
    assert.strictEqual(collidedAt, undefined, `collision at step ${collidedAt} on a clean buffer`);
    assert.strictEqual(buf, after);
  });

  test(`${c.name}: removing the trivia replays byte-exact (trivia on one side only)`, () => {
    const [before, after] = pair({ spec: c.spec, symbol: c.symbol, file: c.trivia, fileAfter: c.plain });
    const steps = buildReplaySteps(before, after, c.spec);
    const { buf, collidedAt } = replay(before, steps, c.spec);
    assert.strictEqual(collidedAt, undefined, `collision at step ${collidedAt} on a clean buffer`);
    assert.strictEqual(buf, after);
  });
}

// --- the field shapes -------------------------------------------------------
// Every one of these is a clean buffer: the human has typed nothing. Contract:
// the loop rebuilds `after` byte for byte, with no collision.

const SHAPES = [
  {
    name: "markdown: paragraph appended at the END of a section (bytes end with a newline)",
    spec: MARKDOWN, symbol: "Setup", file: MD_FILE(MD_SETUP), fileAfter: MD_FILE(MD_SETUP_AFTER),
  },
  {
    name: "markdown: table row inserted immediately ABOVE a blank line",
    spec: MARKDOWN, symbol: "Subsystem map", file: MD_FILE(MD_MAP), fileAfter: MD_FILE(MD_MAP_AFTER),
  },
  {
    name: "python: statement appended at the END of a top-level function",
    spec: PYTHON, symbol: "add", file: PY_TOP_FILE(PY_TOP_PLAIN), fileAfter: PY_TOP_FILE(PY_TOP_APPENDED),
  },
  {
    name: "typescript: doc comment added at the very START of a top-level function",
    spec: TYPESCRIPT, symbol: "total", file: TS_TOP_FILE(TS_TOP_PLAIN), fileAfter: TS_TOP_FILE(TS_TOP_DOC),
  },
  {
    name: "typescript: doc comment removed from a top-level function (trivia one side only)",
    spec: TYPESCRIPT, symbol: "total", file: TS_TOP_FILE(TS_TOP_DOC), fileAfter: TS_TOP_FILE(TS_TOP_PLAIN),
  },
  {
    name: "rust: statement inserted mid-body",
    spec: RUST, symbol: "add", file: RS_TOP_FILE(RS_TOP_PLAIN), fileAfter: RS_TOP_FILE(RS_TOP_MID),
  },
  {
    name: "css: declaration appended at the end of a nested rule",
    spec: CSS, symbol: ".ledger-panel", file: CSS_FILE(CSS_PANEL_PLAIN), fileAfter: CSS_FILE(CSS_PANEL_APPENDED),
  },
];

for (const c of SHAPES) {
  test(`${c.name} — replays byte-exact through the controller loop, no collision`, () => {
    const [before, after] = pair(c);
    const steps = buildReplaySteps(before, after, c.spec);
    assert.ok(steps.length >= 1, "expected at least one op");
    const { buf, collidedAt } = replay(before, steps, c.spec);
    assert.strictEqual(collidedAt, undefined, `collision at step ${collidedAt} of ${steps.length} on a clean buffer`);
    assert.strictEqual(buf, after);
  });
}

// --- ambiguity: repeated blocks and repeated context ------------------------
// A clean-buffer replay over a symbol with identical siblings still has one
// right answer. A mismatch here is silently wrong bytes, the severe class.

const AMBIGUOUS = [
  {
    name: "rust: a distinct block inserted among three identical blank-line-separated blocks",
    spec: RUST, symbol: "add", file: RS_TOP_FILE(RS_TOP_BLOCKS), fileAfter: RS_TOP_FILE(RS_TOP_BLOCKS_AFTER),
  },
  {
    name: "typescript: a distinct statement inserted among three identical statements",
    spec: TYPESCRIPT, symbol: "total", file: TS_TOP_FILE(TS_TOP_REPEAT), fileAfter: TS_TOP_FILE(TS_TOP_REPEAT_AFTER),
  },
  {
    name: "markdown: a distinct paragraph inserted among three identical paragraphs",
    spec: MARKDOWN, symbol: "Rules", file: MD_FILE(MD_RULES), fileAfter: MD_FILE(MD_RULES_AFTER),
  },
];

for (const c of AMBIGUOUS) {
  test(`${c.name} — repeated context still rebuilds byte-exact`, () => {
    const [before, after] = pair(c);
    const steps = buildReplaySteps(before, after, c.spec);
    const { buf, collidedAt } = replay(before, steps, c.spec);
    assert.strictEqual(collidedAt, undefined, `collision at step ${collidedAt} on a clean buffer`);
    assert.strictEqual(buf, after);
  });
}

// --- divergence: land true or collide, never silently wrong -----------------
// A foreign edit is applied to the live buffer and booked on the ledger just
// before the first pure insert resolves. The TRUE landing point is computed
// here by plain arithmetic on the constructed splice - no engine code in the
// expectation. Any other landing is a wrong-bytes defect.

const HUNTED = SHAPES.filter((c) =>
  ["markdown: paragraph appended at the END of a section (bytes end with a newline)",
   "typescript: doc comment added at the very START of a top-level function",
   "rust: statement inserted mid-body",
   "markdown: table row inserted immediately ABOVE a blank line"].includes(c.name),
);

function hunt(shapeName, makeEvent) {
  for (const c of HUNTED) {
    test(`${c.name} — ${shapeName}: lands at its true spot or collides`, () => {
      const [before, after] = pair(c);
      const steps = buildReplaySteps(before, after, c.spec);
      const i = firstInsert(steps);
      assert.ok(i >= 0, `this shape must diff to a pure insert; got ${JSON.stringify(steps.map((s) => s.originalText === ""))}`);
      let expected;
      const events = {
        [i]: (buf, ledger) => {
          const r = resolveStep(buf, parseRoot(buf, c.spec), steps[i], ledgerDelta(ledger), ledger);
          assert.ok(r, "the insert must resolve before the foreign edit");
          const evs = makeEvent(buf, r[0]);
          expected = r[0];
          for (const ev of evs) if (ev.offset + ev.del <= expected) expected += ev.text.length - ev.del;
          return evs;
        },
      };
      const { buf, collidedAt } = replay(before, steps, c.spec, events);
      if (collidedAt !== undefined) {
        assert.ok(collidedAt >= i, `collided at ${collidedAt}, before the shape at ${i}`);
        return; // fail-loud is a correct outcome
      }
      assert.strictEqual(
        buf.slice(expected, expected + steps[i].replacement.length),
        steps[i].replacement,
        `landed somewhere other than the true spot (expected offset ${expected})\nbuffer:\n${buf}`,
      );
    });
  }
}

hunt("the attach line above the point is duplicated", (buf, point) => {
  const lineStart = buf.lastIndexOf("\n", point - 1) + 1;
  const lineEnd = buf.indexOf("\n", lineStart);
  const line = buf.slice(lineStart, lineEnd < 0 ? buf.length : lineEnd + 1);
  if (line === "") return [];
  return [{ offset: lineStart, del: 0, text: line }];
});

hunt("the attach line above the point is deleted", (buf, point) => {
  const lineStart = buf.lastIndexOf("\n", point - 1) + 1;
  if (lineStart === 0) return [];
  const prevStart = buf.lastIndexOf("\n", lineStart - 2) + 1;
  return [{ offset: prevStart, del: lineStart - prevStart, text: "" }];
});

hunt("a foreign paragraph is typed above the symbol's insert point", (buf, point) => {
  const lineStart = buf.lastIndexOf("\n", point - 1) + 1;
  return [{ offset: lineStart, del: 0, text: "ZZZ foreign bytes nobody in this replay wrote ZZZ\n" }];
});

// The human has already typed the exact bytes the step wanted to insert. The
// engine cannot know they are ours, so landing a second copy is defensible and
// so is a collision - but neither copy may be SPLIT by a stale landing.
for (const c of HUNTED) {
  test(`${c.name} — the human already typed the step's own bytes: both copies stay intact or it collides`, () => {
    const [before, after] = pair(c);
    const steps = buildReplaySteps(before, after, c.spec);
    const i = firstInsert(steps);
    assert.ok(i >= 0, "this shape must diff to a pure insert");
    const events = {
      [i]: (buf, ledger) => {
        const r = resolveStep(buf, parseRoot(buf, c.spec), steps[i], ledgerDelta(ledger), ledger);
        assert.ok(r, "the insert must resolve before the foreign edit");
        return [{ offset: r[0], del: 0, text: steps[i].replacement }];
      },
    };
    const { buf, collidedAt } = replay(before, steps, c.spec, events);
    if (collidedAt !== undefined) {
      assert.ok(collidedAt >= i, `collided at ${collidedAt}, before the shape at ${i}`);
      return; // fail-loud is a correct outcome
    }
    const copies = buf.split(steps[i].replacement).length - 1;
    assert.strictEqual(copies, 2, `expected the human's copy and ours intact; found ${copies}\nbuffer:\n${buf}`);
  });
}

// --- byte-level hostility ---------------------------------------------------
// Same contract, over bytes that break offset arithmetic: surrogate pairs and
// combining marks left of the insert point, CRLF, tabs, a file with no
// trailing newline, a very long line, and a symbol whose whole body shifted
// one nesting level. Clean buffer throughout: byte-exact or the engine guessed.

const MD_UNI = `## Notes

Ship it 🚀 and keep the café naïve — the crew said "ok 👍🏽".

Combining marks: é à ñ, and a family: 👨‍👩‍👧‍👦.

`;
const MD_UNI_AFTER = MD_UNI + `One more paragraph, appended after the emoji.

`;

const RS_UNI_PLAIN = `pub fn add(l: &mut Ledger, delta: i64) -> i64 {
    l.log("🚀 done — café");
    if delta > 0 {
        l.total += delta;
    }
    l.total
}`;
const RS_UNI_AFTER = `pub fn add(l: &mut Ledger, delta: i64) -> i64 {
    l.log("🚀 done — café");
    if delta > 0 {
        l.total += delta;
        l.hits += 1;
    }
    l.total
}`;

const PY_UNI_PLAIN = `def add(state, delta):
    """Add a positive delta 🚀 to the café total."""
    if delta > 0:
        state.total += delta`;
const PY_UNI_AFTER = PY_UNI_PLAIN + `
    state.log(delta)`;

const crlf = (s) => s.replace(/\n/g, "\r\n");

const TS_TAB_PLAIN = `export function total(a: number): number {
\tlet out = a;
\tfor (const x of xs) {
\t\tout += x;
\t}
\treturn out;
}`;
const TS_TAB_AFTER = `export function total(a: number): number {
\tlet out = a;
\tfor (const x of xs) {
\t\tout += x;
\t\tout += 1;
\t}
\treturn out;
}`;

const LONG = "x".repeat(5000);
const TS_LONG_PLAIN = `export function total(a: number): number {
  const banner = "${LONG}";
  let out = a;
  return out + banner.length;
}`;
const TS_LONG_AFTER = `export function total(a: number): number {
  const banner = "${LONG}";
  let out = a;
  out += 1;
  return out + banner.length;
}`;

// No trailing newline anywhere in the file, symbol is the last child.
const PY_NONL_BEFORE = `import math


def add(state, delta):
    if delta > 0:
        state.total += delta`;
const PY_NONL_AFTER = PY_NONL_BEFORE + `
    state.log(delta)`;

// The whole symbol moved one nesting level: its body indentation changed and
// nothing else did.
const TS_NS_FILE = `import { xs } from "./xs";

export namespace Wrap {
  export class Ledger {
    private total = 0;

    add(delta: number): number {
      const start = this.total;
      for (const x of xs) {
        this.total += x;
      }
      return this.total - start;
    }
  }
}
`;

const HOSTILE = [
  {
    name: "markdown: append after paragraphs carrying emoji, combining marks and a ZWJ family",
    spec: MARKDOWN, symbol: "Notes", file: MD_FILE(MD_UNI), fileAfter: MD_FILE(MD_UNI_AFTER),
  },
  {
    name: "markdown: CRLF section, paragraph appended at the end",
    spec: MARKDOWN, symbol: "Setup", file: crlf(MD_FILE(MD_SETUP)), fileAfter: crlf(MD_FILE(MD_SETUP_AFTER)),
  },
  {
    name: "rust: statement inserted below a string literal holding an emoji and an em dash",
    spec: RUST, symbol: "add", file: RS_TOP_FILE(RS_UNI_PLAIN), fileAfter: RS_TOP_FILE(RS_UNI_AFTER),
  },
  {
    name: "python: statement appended below a docstring holding an emoji",
    spec: PYTHON, symbol: "add", file: PY_TOP_FILE(PY_UNI_PLAIN), fileAfter: PY_TOP_FILE(PY_UNI_AFTER),
  },
  {
    name: "python: no trailing newline in the file, statement appended at the END",
    spec: PYTHON, symbol: "add", file: PY_NONL_BEFORE, fileAfter: PY_NONL_AFTER,
  },
  {
    name: "typescript: tab-indented body, statement inserted mid-block",
    spec: TYPESCRIPT, symbol: "total", file: TS_TOP_FILE(TS_TAB_PLAIN), fileAfter: TS_TOP_FILE(TS_TAB_AFTER),
  },
  {
    name: "typescript: a 5000-column line above the insert point",
    spec: TYPESCRIPT, symbol: "total", file: TS_TOP_FILE(TS_LONG_PLAIN), fileAfter: TS_TOP_FILE(TS_LONG_AFTER),
  },
  {
    name: "typescript: the whole symbol shifted one nesting level (indent-only change)",
    spec: TYPESCRIPT, symbol: "add", file: TS_FILE(TS_ADD_PLAIN), fileAfter: TS_NS_FILE,
  },
];

for (const c of HOSTILE) {
  test(`${c.name} — replays byte-exact through the controller loop, no collision`, () => {
    const [before, after] = pair(c);
    const steps = buildReplaySteps(before, after, c.spec);
    const { buf, collidedAt } = replay(before, steps, c.spec);
    assert.strictEqual(collidedAt, undefined, `collision at step ${collidedAt} of ${steps.length} on a clean buffer`);
    assert.strictEqual(buf, after);
  });
}

// --- multi-op and twin points -----------------------------------------------
// Sequential policy under several ops in one symbol (each resolve sees the
// buffer the previous landing left), and two IDENTICAL pure inserts at two
// identical blocks - the shape where a context match cannot tell the points
// apart and arithmetic has to carry it.

const RS_MULTI_BEFORE = `pub fn add(l: &mut Ledger, delta: i64) -> i64 {
    let start = l.total;
    if delta > 0 {
        l.total += delta;
    }
    l.log("legacy");
    l.total - start
}`;
const RS_MULTI_AFTER = `pub fn add(l: &mut Ledger, delta: i64) -> i64 {
    let start = l.total;
    l.hits += 1;
    if delta >= 0 {
        l.total += delta;
        l.total += 1;
    }
    l.total - start
}`;

const MD_TWINS = `## Twins

Alpha block line one.
Alpha block line two.

Alpha block line one.
Alpha block line two.

`;
const MD_TWINS_AFTER = `## Twins

Alpha block line one.
Alpha block line two.
Alpha block line three.

Alpha block line one.
Alpha block line two.
Alpha block line three.

`;

const SEQUENCED = [
  {
    name: "rust: four ops in one symbol (two inserts, a condition rewrite, a deleted line)",
    spec: RUST, symbol: "add", file: RS_TOP_FILE(RS_MULTI_BEFORE), fileAfter: RS_TOP_FILE(RS_MULTI_AFTER),
    minSteps: 2, // the tree diff coalesces the four edits into two ops
  },
  {
    name: "markdown: the same line appended to two identical blocks (twin insert points)",
    spec: MARKDOWN, symbol: "Twins", file: MD_FILE(MD_TWINS), fileAfter: MD_FILE(MD_TWINS_AFTER),
    minSteps: 2,
  },
];

for (const c of SEQUENCED) {
  test(`${c.name} — every step resolves against the buffer the last one left, byte-exact`, () => {
    const [before, after] = pair(c);
    const steps = buildReplaySteps(before, after, c.spec);
    assert.ok(steps.length >= c.minSteps, `expected >= ${c.minSteps} ops, got ${steps.length}`);
    const { buf, collidedAt } = replay(before, steps, c.spec);
    assert.strictEqual(collidedAt, undefined, `collision at step ${collidedAt} of ${steps.length} on a clean buffer`);
    assert.strictEqual(buf, after);
  });
}
