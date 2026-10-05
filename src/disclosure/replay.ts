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
import { ObservedEdit, transformRange } from "./ledger";
import { InsertProof, resolveInsertPoint } from "./proof";

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
 *  the exact bytes it replaces, the structural anchor, and — for a pure
 *  insert — the dual-sided context proof baked at build time. */
export interface StepAddress {
  start: number;
  end: number;
  originalText: string;
  anchor: OpAnchor;
  proof?: InsertProof;
}

// The baked range plus our own accepts' delta, byte-validated, and ONLY while
// the ledger holds no foreign edit. A foreign line moves the bytes; this leg
// can't see it and byte-validates on whatever now sits at the stale offset.
// When the human's line is exactly as long as the gap between two equal
// texts, that is the wrong occurrence, silently (review-session-v4 finding 4).
// The ledger leg sees every edit, so it owns that case.
function selfOnlyRange(symText: string, step: StepAddress, selfDelta: number, ledger: readonly ObservedEdit[]): [number, number] | null {
  if (ledger.some((e) => !e.self)) return null;
  const a: [number, number] = [step.start + selfDelta, step.end + selfDelta];
  if (a[0] < 0 || a[1] > symText.length) return null;
  return symText.slice(a[0], a[1]) === step.originalText ? a : null;
}

// The baked range pushed through every observed edit, self and foreign, and
// byte-validated. Before this leg a replace saw only our own accepts
// (selfDelta): a human comment above it broke the arithmetic, shifted the
// structural path onto a neighbour (comments are named nodes), and a short
// non-unique originalText (`value`) left the content leg nothing, so the step
// collided on an edit that never touched it (human-edit-limits.test.cjs).
function ledgerRange(symText: string, step: StepAddress, ledger: readonly ObservedEdit[]): [number, number] | null {
  const t = transformRange(step.start, step.end, ledger);
  if (!t || t[1] > symText.length) return null;
  return symText.slice(t[0], t[1]) === step.originalText ? t : null;
}

// The human's edits reached into this step's own bytes: they took the hunk
// over. Any other byte-valid match is a twin, not the target. With `alpha`
// rewritten to `gamma` in `g(alpha, alpha)`, the content leg found the one
// `alpha` left, the argument the human never touched (review-session-v4 F).
// No leg may land; the controller reads the collision as "taken over".
function touchedByHuman(step: StepAddress, ledger: readonly ObservedEdit[]): boolean {
  return ledger.some((e) => !e.self) && transformRange(step.start, step.end, ledger) === null;
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
 * (shell). A pure insert has no bytes of its own to validate, so its point is
 * transformed through the ledger and every leg is gated by the dual-sided
 * context proof (proof.ts) — the raw-arithmetic guess that landed the live
 * incident 175 bytes stale is gone. Null means collision — surface, never
 * guess.
 */
export function resolveStepNoTree(
  symText: string,
  step: StepAddress,
  selfDelta: number,
  ledger: readonly ObservedEdit[],
): [number, number] | null {
  if (step.originalText === "") {
    const p = resolveInsertPoint(symText, step, ledger, null);
    return p === null ? null : [p, p];
  }
  const a = selfOnlyRange(symText, step, selfDelta, ledger);
  if (a) return a;
  if (touchedByHuman(step, ledger)) return null;
  const lr = ledgerRange(symText, step, ledger);
  if (lr) return lr;
  return resolveByContent(symText, step.originalText);
}

export function resolveStep(
  symText: string,
  root: SyntaxNode,
  step: StepAddress,
  selfDelta: number,
  ledger: readonly ObservedEdit[],
): [number, number] | null {
  const sr = tryResolveOp(root, step.anchor);
  if (step.originalText === "") {
    // The ledger-transformed arithmetic leads (exact under every observed
    // edit, self and foreign); the structural anchor is the rescue when a
    // straddling edit dirtied the point. Both gated by the dual proof.
    const p = resolveInsertPoint(symText, step, ledger, sr ? sr[0] : null);
    return p === null ? null : [p, p];
  }
  const a = selfOnlyRange(symText, step, selfDelta, ledger);
  if (a) return a;
  if (touchedByHuman(step, ledger)) return null;
  const lr = ledgerRange(symText, step, ledger);
  if (lr) return lr;
  // A foreign edit renumbers named-child paths (comments are named nodes), so
  // a byte-valid structural hit may be a twin of the target, not the target:
  // a comment before `g(alpha, alpha)` plus a typo fixed inside the second
  // `alpha` put the replace on the first (review-session-v4 finding B). With
  // the human's edits on the ledger, only the unique-content leg remains.
  if (!ledger.some((e) => !e.self) && sr && symText.slice(sr[0], sr[1]) === step.originalText) return sr;
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
