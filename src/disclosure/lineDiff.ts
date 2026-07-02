// Line-grain diff for Patch steps — the file-level converge the symbol-grain
// engine can't express. A Patch step's hunks are whatever line runs still
// differ between the live target file and the sandbox file: import edits,
// module doc headers, top-level items whose home is a convention ("after the
// imports"), whole blocks in languages with no grammar. Both sides are real
// file bytes, so ground truth holds; the output is the same ReplayStep shape
// diff-replay already serves, resolved without a parse (arithmetic + content
// legs only — see resolveStepNoTree).

import { EditOp, OpAnchor } from "./diff";
import { ReplayStep } from "./sequence";

// A Patch op never re-anchors structurally; the anchor field just satisfies the
// EditOp shape.
const NO_ANCHOR: OpAnchor = { path: [], left: { at: "innerLeft" }, right: { at: "innerRight" } };

// Split keeping each line's own EOL, so ops splice byte-exact on CRLF and LF alike.
function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

// LCS pairs over the middle lines (common prefix/suffix already trimmed). The
// middle of a nearly-converged file is small; a pathological middle falls back
// to one whole-block replace — coarser, still byte-exact.
const MAX_DP_CELLS = 1_000_000;

function lcsPairs(a: string[], b: string[]): [number, number][] | null {
  const m = a.length, n = b.length;
  if (m * n > MAX_DP_CELLS) return null;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * The ordered replay steps that turn `oldText` into `newText` at line grain.
 * One step per changed line run; identical texts produce none. Every step's
 * `originalText` is a byte-exact slice of `oldText` and every replacement is a
 * byte-exact slice of `newText` — nothing is synthesized.
 */
export function lineDiffSteps(oldText: string, newText: string): ReplayStep[] {
  if (oldText === newText) return [];
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // Trim the common frame; only the middle needs alignment.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;

  const aMid = a.slice(pre, a.length - post);
  const bMid = b.slice(pre, b.length - post);

  // Old-coordinate byte offset of line index `i` (within the full line arrays).
  const lineStarts: number[] = new Array(a.length + 1);
  lineStarts[0] = 0;
  for (let i = 0; i < a.length; i++) lineStarts[i + 1] = lineStarts[i] + a[i].length;
  const bStarts: number[] = new Array(b.length + 1);
  bStarts[0] = 0;
  for (let i = 0; i < b.length; i++) bStarts[i + 1] = bStarts[i] + b[i].length;

  const pairs = lcsPairs(aMid, bMid);
  const ops: EditOp[] = [];
  const emit = (aFrom: number, aTo: number, bFrom: number, bTo: number) => {
    if (aFrom === aTo && bFrom === bTo) return;
    const start = lineStarts[pre + aFrom];
    const end = lineStarts[pre + aTo];
    const replacement = newText.slice(bStarts[pre + bFrom], bStarts[pre + bTo]);
    const oldSlice = oldText.slice(start, end);
    const kind = oldSlice === "" ? "insert" : replacement === "" ? "delete" : "replace";
    ops.push({ start, end, replacement, kind, oldText: oldSlice, anchor: NO_ANCHOR });
  };

  if (pairs === null) {
    emit(0, aMid.length, 0, bMid.length); // pathological middle: one block swap
  } else {
    let pa = 0, pb = 0;
    for (const [ai, bi] of pairs) {
      emit(pa, ai, pb, bi);
      pa = ai + 1;
      pb = bi + 1;
    }
    emit(pa, aMid.length, pb, bMid.length);
  }

  return ops.map((op) => ({
    ...op,
    singleLine: !op.oldText.includes("\n") && !op.replacement.includes("\n"),
    originalText: op.oldText,
  }));
}
