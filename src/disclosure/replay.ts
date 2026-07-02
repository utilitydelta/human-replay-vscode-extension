// Live re-anchored replay of an edit script.
//
// The baked-offset walk (walk.ts) trusts that nothing but its own inserts moves
// the buffer. Delete and replace target *existing* branch text, and the human
// diverges, so the edit-aware engine cannot trust absolute offsets. Each EditOp
// carries a semantic anchor (a named-child-index path + landmarks, see diff.ts);
// replay re-parses the live buffer and resolves every op against the current
// tree before applying. An op whose surroundings shifted still lands on the right
// node. Model-free, like the rest of disclosure.

import { EditOp, Landmark, OpAnchor, parseRoot } from "./diff";
import { SyntaxNode } from "./walk";

// Walk a named-child-index path from the root to the addressed node.
function resolvePath(root: SyntaxNode, path: number[]): SyntaxNode {
  let node = root;
  for (const i of path) {
    const child = node.namedChild(i);
    if (!child) throw new Error(`anchor path [${path}] broke at index ${i}`);
    node = child;
  }
  return node;
}

function resolveLandmark(node: SyntaxNode, lm: Landmark): number {
  switch (lm.at) {
    case "childStart": return node.namedChild(lm.i)!.startIndex;
    case "childEnd": return node.namedChild(lm.i)!.endIndex;
    case "innerLeft": return node.namedChild(0)!.startIndex;
    case "innerRight": return node.namedChild(node.namedChildCount - 1)!.endIndex;
  }
}

/** Resolve an op's anchor against `root` to a live `[start, end)` byte range.
 *  `trimEnd` bytes (a newline tail the op excludes) come off the right edge. */
export function resolveOp(root: SyntaxNode, anchor: OpAnchor): [number, number] {
  const node = resolvePath(root, anchor.path);
  return [resolveLandmark(node, anchor.left), resolveLandmark(node, anchor.right) - (anchor.trimEnd ?? 0)];
}

/**
 * Soft resolve for the live UI: the byte range, or `null` when the anchor no
 * longer resolves — the node it addresses was edited away, so the path or a
 * landmark child is gone. The batch replay wants `resolveOp` to throw loud; the
 * interactive controller wants this so a human's structural edit *surfaces* (panel
 * blocked, finish by hand) instead of crashing the provider. Resolution failure is
 * exactly "the structure moved", so a catch is the right boundary here.
 */
export function tryResolveOp(root: SyntaxNode, anchor: OpAnchor): [number, number] | null {
  try {
    return resolveOp(root, anchor);
  } catch {
    return null;
  }
}

/** The live region a symbol occupies in the document: where it starts and how long. */
export interface SymbolWindow {
  anchorOffset: number;
  symbolLen: number;
}

/**
 * Shift a symbol window to absorb one buffer edit, so the controller's re-parse keeps
 * reading the exact symbol bytes after the human types. The controller only books its
 * OWN swaps into `symbolLen`; a human keystroke is otherwise invisible, and a window
 * even one byte short truncates the closing brace — the re-parse then errors and the
 * re-anchor holds forever. An edit entirely before the symbol shifts the whole window;
 * one inside it grows or shrinks `symbolLen`; one after it leaves the window untouched.
 * Offsets are the pre-edit document's (the VS Code change-event convention).
 */
export function shiftWindow(
  w: SymbolWindow,
  edit: { rangeOffset: number; rangeLength: number; textLength: number },
): SymbolWindow {
  const delta = edit.textLength - edit.rangeLength;
  if (edit.rangeOffset + edit.rangeLength <= w.anchorOffset) {
    return { anchorOffset: w.anchorOffset + delta, symbolLen: w.symbolLen };
  }
  if (edit.rangeOffset <= w.anchorOffset + w.symbolLen) {
    return { anchorOffset: w.anchorOffset, symbolLen: w.symbolLen + delta };
  }
  return w;
}

/**
 * Fallback re-anchor by content: the `[start, end)` of `originalText` in `buffer`
 * when it occurs **exactly once**, else null. The structural anchor (a named-child
 * index path) drifts to the wrong node when the human edits the op's own line —
 * wrapping `peer.lease_expiry < now` in `1 == 1 && …` shifts the indices so the
 * path resolves to `1 == 1` instead. The text the op replaces is stable across
 * that wrap, so a unique-substring match re-locates it without inference. Uniqueness
 * is the safety: zero matches (the text is gone) or several (ambiguous which one)
 * both return null, so the controller surfaces rather than guessing. Empty
 * `originalText` (a pure insert) has nothing to match — null.
 */
export function resolveByContent(buffer: string, originalText: string): [number, number] | null {
  if (!originalText) return null;
  const first = buffer.indexOf(originalText);
  if (first < 0) return null;
  if (buffer.indexOf(originalText, first + 1) >= 0) return null; // ambiguous — more than one match
  return [first, first + originalText.length];
}

/** What the interactive resolver needs from a step: the baked old-source range,
 *  the exact bytes it replaces, and the structural anchor. */
export interface StepAddress {
  start: number;
  end: number;
  originalText: string;
  anchor: OpAnchor;
}

/**
 * Resolve one step of the interactive walk against the live symbol text.
 *
 * The controller's own accepts change the buffer by known amounts, and an accept
 * that adds or removes a named sibling (a doc-comment line, a new statement)
 * shifts every structural index path after it — the anchor of the NEXT op then
 * resolves to nothing or to the wrong node. But those self-edits shift later
 * baked ranges by pure arithmetic, so try that first: the baked range plus
 * `selfDelta` (the running sum of accepted replacements' length deltas), trusted
 * only when the live bytes there equal `originalText`. A human edit breaks that
 * byte check and falls through to the structural anchor, then to a
 * unique-substring match. A pure insert has no bytes to validate, so structure
 * leads and arithmetic is the sibling-shift rescue. Null means collision —
 * surface it, never guess.
 */
/**
 * The parse-free resolver for line-grain Patch steps: arithmetic (byte-
 * validated) → unique-content match. No structural leg — a Patch op's hunks
 * live between lines, not tree nodes, and the file may have no grammar at all
 * (shell). A pure insert trusts arithmetic alone: only our own accepts shift
 * bytes, and their delta is exact. Null means collision — surface, never guess.
 */
export function resolveStepNoTree(
  symText: string,
  step: StepAddress,
  selfDelta: number,
): [number, number] | null {
  const a: [number, number] = [step.start + selfDelta, step.end + selfDelta];
  const aInBounds = a[0] >= 0 && a[1] <= symText.length;
  if (step.originalText === "") return aInBounds ? a : null;
  if (aInBounds && symText.slice(a[0], a[1]) === step.originalText) return a;
  return resolveByContent(symText, step.originalText);
}

export function resolveStep(
  symText: string,
  root: SyntaxNode,
  step: StepAddress,
  selfDelta: number,
): [number, number] | null {
  const a: [number, number] = [step.start + selfDelta, step.end + selfDelta];
  const aInBounds = a[0] >= 0 && a[1] <= symText.length;
  const sr = tryResolveOp(root, step.anchor);
  if (step.originalText === "") return sr ?? (aInBounds ? a : null);
  if (aInBounds && symText.slice(a[0], a[1]) === step.originalText) return a;
  if (sr && symText.slice(sr[0], sr[1]) === step.originalText) return sr;
  return resolveByContent(symText, step.originalText);
}

/**
 * Apply `ops` to `buffer` by re-anchoring each against the buffer's live tree —
 * not the offsets baked at diff time. The ops come from one diff, so they are
 * non-overlapping and resolve against a single parse. Returns the new buffer.
 */
export function replayLive(buffer: string, ops: EditOp[]): string {
  const root = parseRoot(buffer);
  const resolved = ops
    .map((op) => ({ ...resolveRange(root, op), text: op.replacement }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  let out = "", cursor = 0;
  for (const r of resolved) {
    if (r.start < cursor) throw new Error(`overlapping op at ${r.start} < ${cursor}`);
    out += buffer.slice(cursor, r.start) + r.text;
    cursor = r.end;
  }
  return out + buffer.slice(cursor);
}

function resolveRange(root: SyntaxNode, op: EditOp): { start: number; end: number } {
  const [start, end] = resolveOp(root, op.anchor);
  return { start, end };
}
