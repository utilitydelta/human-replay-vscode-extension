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

// LCS pairs over the middle lines (common prefix/suffix already trimmed). Three
// tiers, chosen by the middle's cell count m*n:
//   - small (<= MAX_DP_CELLS): the full O(m*n) DP table — fast, the common path.
//   - large (<= MAX_HIRSCHBERG_CELLS): linear-space Hirschberg — same optimal
//     alignment, O(min(m,n)) space. This is the tier that fixes the old collapse:
//     a scattered patch on a large file stays granular instead of becoming one
//     whole-file replace that the human Tabs through unread.
//   - enormous (> MAX_HIRSCHBERG_CELLS): a single coarse block replace. Above this
//     size Hirschberg's O(m*n) sweep would freeze the UI thread for seconds, and a
//     middle this large is either a reformat/regeneration (nothing aligns, so one
//     block IS the right output) or a grammared file that should have been
//     decomposed into symbol steps upstream. The block is deliberate and stays
//     visible in the [diff-replay] hunk-count log, not a silent size cap.
const MAX_DP_CELLS = 1_000_000;

// Above this the linear-space pass is still correct but too slow to run on the
// extension-host thread (m*n line comparisons). Tuned to admit realistically-sized
// scattered patches (a few thousand lines each side) and reject only the pathological
// reformat-the-world middles, which collapse to one block anyway.
const MAX_HIRSCHBERG_CELLS = 30_000_000;

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

// One row of LCS lengths for a[a0..a1) against b[b0..b1), scanning a forward:
// entry k is the LCS length of the a-slice with b[b0..b0+k). O(len·len) time,
// O(len(b)) space — the linear-space half of Hirschberg.
function lcsRowFwd(a: string[], a0: number, a1: number, b: string[], b0: number, b1: number): number[] {
  const n = b1 - b0;
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = a0; i < a1; i++) {
    for (let j = 0; j < n; j++) {
      curr[j + 1] = a[i] === b[b0 + j] ? prev[j] + 1 : Math.max(prev[j + 1], curr[j]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev;
}

// The mirror row, scanning a backward: entry k is the LCS length of the a-slice
// with the b-suffix b[b0+k..b1).
function lcsRowRev(a: string[], a0: number, a1: number, b: string[], b0: number, b1: number): number[] {
  const n = b1 - b0;
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = a1 - 1; i >= a0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      curr[j] = a[i] === b[b0 + j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev;
}

// Hirschberg's divide-and-conquer LCS: the same optimal matched-line pairs the DP
// traceback yields, in O(min(m,n)) space instead of O(m·n). Used above the DP cell
// cap so a large scattered patch still resolves to granular hunks rather than one
// whole-file replace. Total work stays O(m·n) (each recursion halves the a-span),
// which is milliseconds for a real source file's middle.
function hirschbergPairs(a: string[], b: string[]): [number, number][] {
  const pairs: [number, number][] = [];
  const rec = (a0: number, a1: number, b0: number, b1: number): void => {
    if (a1 <= a0 || b1 <= b0) return;
    if (a1 - a0 === 1) {
      for (let j = b0; j < b1; j++) if (b[j] === a[a0]) { pairs.push([a0, j]); return; }
      return;
    }
    const mid = (a0 + a1) >> 1;
    const fwd = lcsRowFwd(a, a0, mid, b, b0, b1);
    const rev = lcsRowRev(a, mid, a1, b, b0, b1);
    let best = -1, split = b0;
    for (let j = b0; j <= b1; j++) {
      const s = fwd[j - b0] + rev[j - b0];
      if (s > best) { best = s; split = j; }
    }
    rec(a0, mid, b0, split);
    rec(mid, a1, split, b1);
  };
  rec(0, a.length, 0, b.length);
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

  // Small middle: the eager DP table (fast, unchanged output). Large middle: the
  // linear-space Hirschberg pass, same optimal alignment without the memory blowup.
  // Enormous middle: no pairs, i.e. one coarse block replace, rather than a
  // multi-second Hirschberg sweep on the UI thread (see MAX_HIRSCHBERG_CELLS).
  const cells = aMid.length * bMid.length;
  const pairs =
    lcsPairs(aMid, bMid) ?? (cells <= MAX_HIRSCHBERG_CELLS ? hirschbergPairs(aMid, bMid) : []);
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

  let pa = 0, pb = 0;
  for (const [ai, bi] of pairs) {
    emit(pa, ai, pb, bi);
    pa = ai + 1;
    pb = bi + 1;
  }
  emit(pa, aMid.length, pb, bMid.length);

  return ops.map((op) => ({
    ...op,
    singleLine: !op.oldText.includes("\n") && !op.replacement.includes("\n"),
    originalText: op.oldText,
  }));
}

/**
 * The byte span in `newText` that bounds every line changed from `oldText` — the
 * block a Patch step actually touches. Trims the common line prefix and suffix;
 * what remains, expanded to whole lines, is the changed region. Returns
 * undefined when the texts are identical. A retrospective anchors on this span
 * instead of the whole file, so the squiggle sits on the change, not the code
 * around it.
 */
export function changedLineSpan(oldText: string, newText: string): { offset: number; len: number } | undefined {
  if (oldText === newText) return undefined;
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  const bStarts: number[] = new Array(b.length + 1);
  bStarts[0] = 0;
  for (let i = 0; i < b.length; i++) bStarts[i + 1] = bStarts[i] + b[i].length;
  const offset = bStarts[pre];
  const end = bStarts[b.length - post];
  return { offset, len: Math.max(0, end - offset) };
}
