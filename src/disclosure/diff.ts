// Tree diff: old symbol AST vs new symbol AST -> a node-level edit script.
//
// The foundation of the edit-aware engine. `computeSteps` (walk.ts) handles the
// degenerate `diff(∅-body, body)` where every node is an insertion; this handles
// the general `diff(old, new)` of add, delete, and modify. Proven in spike S9
// (50 checks): apply the script to old and get new byte-exact, every inserted
// token a real new token, every deleted token a real old token, unchanged
// subtrees left untouched. Model-free, same as the rest of disclosure.
//
// Mechanism (GumTree-lite): match unchanged children across the two trees by an
// LCS keyed on node text (identical subtrees anchor), then emit one op per
// changed run between anchors. A run that is a single matched same-type pair
// recurses (minimal, stable nested edits); any other run is a contiguous splice
// copying the new gap-bytes over the old gap-span, so separators travel with the
// run and no token is synthesized. A per-node verification guard catches changes
// hiding in anonymous tokens (the `<` -> `<=` operator, whose named children are
// unchanged) by falling back to replace-whole. Correctness over minimality.

import Parser = require("tree-sitter");
import Rust = require("tree-sitter-rust");
import { SyntaxNode } from "./walk";

export type OpKind = "insert" | "delete" | "replace";

// A byte boundary named *relative to a tree node*, not as an absolute offset —
// so it re-resolves against a live buffer after the human's edits shift offsets.
// `innerLeft`/`innerRight` are the node's first-child-start / last-child-end (the
// frame-preserving bounds); childStart/childEnd are a specific child's edges.
export type Landmark =
  | { at: "childStart"; i: number }
  | { at: "childEnd"; i: number }
  | { at: "innerLeft" }
  | { at: "innerRight" };

// Where an op lands, addressed semantically: the named-child-index path from the
// root to the op's parent node, plus the left/right landmarks bounding the range
// within it. Resolved live (re-parse, walk the path, read the landmarks) so the
// op survives divergence that moved bytes but not structure. This is the MVP
// anchor — within-session, tree-sitter identity; rust-analyzer reconciliation
// (S2) is the cross-session hardening, deferred.
export interface OpAnchor {
  path: number[];
  left: Landmark;
  right: Landmark;
  /** Bytes the op excludes from the right landmark's node edge. Comment tokens
   *  span their trailing newline; an op trimmed of a shared newline tail ends
   *  before the node does, and a live re-resolve must end there too. */
  trimEnd?: number;
}

// A node-level edit. `kind` is read from the tree alignment, not inferred from
// whether a side is empty (a middle delete surfaces as a gap-replace). `start`/
// `end` are OLD-source coordinates (the happy path); `anchor` re-resolves the
// same range against a live buffer. Downstream UX keys off `kind`.
export interface EditOp {
  start: number;
  end: number;
  replacement: string;
  kind: OpKind;
  oldText: string;
  anchor: OpAnchor;
}

export interface Diff {
  ops: EditOp[];
  /** Old-source ranges proven unchanged (anchored). Never touched by an op. */
  stable: [number, number][];
  /** Old-source ranges relocated-but-identical: the move-aware (GumTree) gap. */
  moved: [number, number][];
}

let sharedParser: Parser | null = null;
function parser(): Parser {
  if (!sharedParser) {
    sharedParser = new Parser();
    sharedParser.setLanguage(Rust as unknown as Parser.Language);
  }
  return sharedParser;
}

const named = (node: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i)!);
  return out;
};

const slice = (n: SyntaxNode, src: string) => src.slice(n.startIndex, n.endIndex);

// LCS over two node arrays keyed by source text. Returns matched index pairs
// [oi, ni] in order — the stable anchors. Tie-break keeps positions aligned,
// which is what lets a reorder's unmoved middle element stay put.
function anchorPairs(oc: SyntaxNode[], nc: SyntaxNode[], oSrc: string, nSrc: string): [number, number][] {
  const m = oc.length, n = nc.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = slice(oc[i], oSrc) === slice(nc[j], nSrc)
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (slice(oc[i], oSrc) === slice(nc[j], nSrc)) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] > dp[i][j + 1]) i++;
    else if (dp[i + 1][j] < dp[i][j + 1]) j++;
    else if (i <= j) i++;
    else j++;
  }
  return pairs;
}

// Apply the ops overlapping [from, to) to that slice of src, in src coords.
// Asserts non-overlap. from=0,to=src.length applies the whole script.
export function applyRange(src: string, from: number, to: number, ops: EditOp[]): string {
  const sorted = ops
    .filter((e) => e.start >= from && e.end <= to)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "", cursor = from;
  for (const e of sorted) {
    if (e.start < cursor) throw new Error(`overlapping edit at ${e.start} < ${cursor}`);
    out += src.slice(cursor, e.start) + e.replacement;
    cursor = e.end;
  }
  return out + src.slice(cursor, to);
}

// Recurse a matched pair (o, n) into edit ops in OLD coordinates. An unchanged
// subtree produces no op. `stable` collects proven-unchanged old ranges; `moved`
// collects relocated-but-identical old children (the move-aware gap).
function editsFor(
  o: SyntaxNode,
  n: SyntaxNode,
  oSrc: string,
  nSrc: string,
  path: number[],
  stable: [number, number][],
  moved: [number, number][],
): EditOp[] {
  const oText = slice(o, oSrc);
  const nText = slice(n, nSrc);
  if (oText === nText) {
    stable.push([o.startIndex, o.endIndex]);
    return [];
  }
  // o addressed as a child of its parent (path[-1]); the root has no parent, so
  // it is addressed by its own inner bounds.
  const wholeAnchor: OpAnchor = path.length
    ? { path: path.slice(0, -1), left: { at: "childStart", i: path[path.length - 1] }, right: { at: "childEnd", i: path[path.length - 1] } }
    : { path: [], left: { at: "innerLeft" }, right: { at: "innerRight" } };
  // A shared newline tail (comment tokens span their trailing "\n") would promote
  // a one-line rewrite to a multi-line block and change how it is served — trim it
  // and let the anchor carry the trim for live re-resolution. Byte-exact either
  // way; only the op's line-ness is at stake.
  const replaceWhole = (): EditOp[] => {
    let k = 0;
    while (k < oText.length - 1 && k < nText.length - 1 && oText[oText.length - 1 - k] === "\n" && nText[nText.length - 1 - k] === "\n") k++;
    const anchor = k > 0 ? { ...wholeAnchor, trimEnd: k } : wholeAnchor;
    return [{
      start: o.startIndex,
      end: o.endIndex - k,
      replacement: k > 0 ? nText.slice(0, -k) : nText,
      kind: "replace",
      oldText: k > 0 ? oText.slice(0, -k) : oText,
      anchor,
    }];
  };

  const oc = named(o), nc = named(n);
  if (o.type !== n.type || oc.length === 0 || nc.length === 0) return replaceWhole();

  const pairs = anchorPairs(oc, nc, oSrc, nSrc);
  const ops: EditOp[] = [];
  const localStable: [number, number][] = [];

  // Move-aware gap: an old child with an exact text-twin among the *unmatched*
  // new children is content that merely relocated. A text-keyed LCS cannot keep
  // it in place, so it is re-emitted as change.
  const matchedO = new Set(pairs.map(([oi]) => oi));
  const matchedN = new Set(pairs.map(([, ni]) => ni));
  const freeNew = nc.map((c, j): [number, string] => [j, slice(c, nSrc)]).filter(([j]) => !matchedN.has(j));
  for (let i = 0; i < oc.length; i++) {
    if (matchedO.has(i)) continue;
    const t = slice(oc[i], oSrc);
    const hit = freeNew.find(([, nt]) => nt === t);
    if (hit) { moved.push([oc[i].startIndex, oc[i].endIndex]); freeNew.splice(freeNew.indexOf(hit), 1); }
  }

  // Outer bounds preserve the container frame (start->firstChild, lastChild->end).
  const oLeftAll = oc[0].startIndex, oRightAll = oc[oc.length - 1].endIndex;
  const nLeftAll = nc[0].startIndex, nRightAll = nc[nc.length - 1].endIndex;

  // Walk the gaps between consecutive anchors. A run's byte span is the gap from
  // the previous anchor's end to the next anchor's start, so separators travel.
  let pOi = -1, pNi = -1;
  const flush = (oNext: number, nNext: number) => {
    const oRun: number[] = []; for (let k = pOi + 1; k < oNext; k++) oRun.push(k);
    const nRun: number[] = []; for (let k = pNi + 1; k < nNext; k++) nRun.push(k);
    if (oRun.length === 0 && nRun.length === 0) return;

    // Peel same-type pairs off both ends of the run and recurse them as in-place
    // modifications; splice only the unmatched middle. This keeps a changed child
    // surgical even when the run lengths differ — a changed signature beside a
    // changed body, or a doc-comment block that gained a line above a changed fn
    // (comments align from the front, the fn from the back, only the extra comment
    // line splices). Every pair-recursion and the middle splice are byte-exact, so
    // the node-level guard below still backstops any mis-pairing with replace-whole.
    let lo = 0;
    while (lo < oRun.length && lo < nRun.length && oc[oRun[lo]].type === nc[nRun[lo]].type) lo++;
    let oHi = oRun.length, nHi = nRun.length;
    while (oHi > lo && nHi > lo && oc[oRun[oHi - 1]].type === nc[nRun[nHi - 1]].type) { oHi--; nHi--; }
    for (let k = 0; k < lo; k++) {
      ops.push(...editsFor(oc[oRun[k]], nc[nRun[k]], oSrc, nSrc, [...path, oRun[k]], localStable, moved));
    }
    for (let k = oHi, kn = nHi; k < oRun.length; k++, kn++) {
      ops.push(...editsFor(oc[oRun[k]], nc[nRun[kn]], oSrc, nSrc, [...path, oRun[k]], localStable, moved));
    }
    if (lo >= oHi && lo >= nHi) return; // the peels covered the whole run

    // Middle splice: the gap between the last front-peeled child (or the run's left
    // bound) and the first back-peeled child (or the run's right bound). Separators
    // on both sides travel with it, so they are addressed by those children's edges.
    const oStart = lo > 0 ? oc[oRun[lo - 1]].endIndex : pOi >= 0 ? oc[pOi].endIndex : oLeftAll;
    const oEnd = oHi < oRun.length ? oc[oRun[oHi]].startIndex : oNext < oc.length ? oc[oNext].startIndex : oRightAll;
    const nStart = lo > 0 ? nc[nRun[lo - 1]].endIndex : pNi >= 0 ? nc[pNi].endIndex : nLeftAll;
    const nEnd = nHi < nRun.length ? nc[nRun[nHi]].startIndex : nNext < nc.length ? nc[nNext].startIndex : nRightAll;
    const replacement = nSrc.slice(nStart, nEnd);
    const text = oSrc.slice(oStart, oEnd);
    const kind: OpKind = text === "" ? "insert" : replacement === "" ? "delete" : "replace";
    const anchor: OpAnchor = {
      path,
      left: lo > 0 ? { at: "childEnd", i: oRun[lo - 1] } : pOi >= 0 ? { at: "childEnd", i: pOi } : { at: "innerLeft" },
      right: oHi < oRun.length ? { at: "childStart", i: oRun[oHi] } : oNext < oc.length ? { at: "childStart", i: oNext } : { at: "innerRight" },
    };
    ops.push({ start: oStart, end: oEnd, replacement, kind, oldText: text, anchor });
  };

  for (const [oi, ni] of pairs) {
    flush(oi, ni);
    localStable.push([oc[oi].startIndex, oc[oi].endIndex]);
    pOi = oi; pNi = ni;
  }
  flush(oc.length, nc.length);

  // Guard: a change can hide in anonymous tokens between two unchanged named
  // children. The child alignment is blind to it; verify the ops rebuild this
  // node and, on mismatch, fall back to replace-whole (always byte-exact).
  if (applyRange(oSrc, o.startIndex, o.endIndex, ops) !== nText) return replaceWhole();

  stable.push(...localStable);
  return ops;
}

/**
 * Diff the first item subtree of `oldSrc` against `newSrc`. Returns the edit
 * script in OLD-source coordinates plus the stable and moved ranges.
 */
export function diffSymbols(oldSrc: string, newSrc: string): Diff {
  const o = parseRoot(oldSrc);
  const n = parseRoot(newSrc);
  const stable: [number, number][] = [];
  const moved: [number, number][] = [];
  const ops = editsFor(o, n, oldSrc, newSrc, [], stable, moved);
  return { ops, stable, moved };
}

/** Parse `src` to its root node — the shared entry for diff and live re-anchor. */
export function parseRoot(src: string): SyntaxNode {
  return parser().parse(src).rootNode as unknown as SyntaxNode;
}
