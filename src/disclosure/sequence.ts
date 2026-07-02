// The diff-replay step sequence: the controller's input contract.
//
// diff.ts produces an unordered set of node-level ops; the controller replays
// them one Tab at a time, in reading order, and has to know which surface each
// op can use. This orders the ops by position and classifies each: a same-line
// replace or delete rides the native inline-completion surface (its `range` must
// begin and end on one line), everything else (a multi-line delete/replace, or
// an insert that opens new lines) needs the descend-and-fill walk or a decoration
// layer. Model-free, like the rest of disclosure.

import { diffSymbols, EditOp } from "./diff";

export interface ReplayStep extends EditOp {
  /**
   * The op fits the native inline-completion `range` (begins and ends on one
   * line, replacement adds no newline). If false the controller routes it to the
   * descend-and-fill walk (inserts) or the decoration layer (multi-line edits).
   */
  singleLine: boolean;
  /**
   * The exact source text this op replaces, captured from the original buffer.
   * The controller re-anchors structurally first; when the human's on-line edit
   * drifts that index path to the wrong node (e.g. wrapping the condition in
   * `1 == 1 &&` shifts the named-child indices), the controller falls back to a
   * unique-substring search for this text so the ghost re-shows on the right span
   * instead of clobbering the edit. Empty for a pure insert (nothing to match).
   */
  originalText: string;
}

// Classified from the baked old range — a benign divergence shifts the bytes but
// not the single-line-ness, so this is stable enough to route on.
function isSingleLine(oldSrc: string, op: EditOp): boolean {
  return !oldSrc.slice(op.start, op.end).includes("\n") && !op.replacement.includes("\n");
}

// A multi-line op that only ADDS bytes around its unchanged old span is a pure
// insertion — the "open a line" gesture (a new argument, a new statement), not a
// block swap. Serving it as a zero-width ghost at one point renders cleanly where a
// replace-over-a-multi-line-range cannot. Returns where to insert relative to the
// op's live range (`atEnd`: just past the old span; else just before it) and the
// bytes to insert, or null when the op genuinely rewrites existing lines.
export function asInsertion(oldText: string, replacement: string): { atEnd: boolean; text: string } | null {
  if (oldText === "") return { atEnd: false, text: replacement }; // already a point insert
  if (oldText === replacement) return null;
  if (replacement.startsWith(oldText)) return { atEnd: true, text: replacement.slice(oldText.length) };
  if (replacement.endsWith(oldText)) return { atEnd: false, text: replacement.slice(0, replacement.length - oldText.length) };
  return null;
}

/** Ordered, surface-classified replay steps for `diff(old, new)`. */
export function buildReplaySteps(oldSrc: string, newSrc: string): ReplayStep[] {
  const { ops } = diffSymbols(oldSrc, newSrc);
  return ops
    .map((op) => ({ ...op, singleLine: isSingleLine(oldSrc, op), originalText: oldSrc.slice(op.start, op.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
