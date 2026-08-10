// The observed-delta ledger: every buffer change the session sees, booked in
// symbol-relative coordinates in arrival order, so an unlanded step's baked
// offset can be transformed to where those bytes actually sit NOW.
//
// Why: a pure insert (`originalText === ""`) is the one op shape with no proof
// bytes on any leg. When a foreign edit (another provider's ghost, a human
// paste) lands upstream of an armed insert, the baked offset goes stale by
// exactly that edit's delta — the live incident landed two inserts 175 bytes
// wrong, splitting a word and an indent. The change events carry exact
// `rangeOffset/rangeLength/textLength`, so the correction is pure arithmetic
// (OT-style point transform), the same trick shiftWindow plays for the symbol
// window. Model-free by construction.
//
// The ledger is unified: our own accepts book here too, in event order.
// `selfDelta` (a running sum) still serves the byte-validated legs, but a sum
// can't order self accepts against foreign edits — the transform can, because
// each entry is applied in the coordinates the buffer actually had when it
// arrived.

/** One buffer change in symbol-relative, arrival-time coordinates:
 *  `[offset, offset + rangeLength)` was replaced by `textLength` bytes.
 *  `offset` may be negative — an edit straddling the window start books at
 *  its true position so a point at relative 0 correctly reads as straddled
 *  (the clamped-to-zero version let a straddle-plus-undo drift the anchor
 *  while the point stayed clean — the hunt's 3e counterexample).
 *  `self` marks our own accepts: an insert exactly AT a later point is
 *  ambiguous when foreign (whose bytes come first?) but not when ours — our
 *  bytes are the step sequence's own output and always precede later steps. */
export interface ObservedEdit {
  offset: number;
  rangeLength: number;
  textLength: number;
  self?: boolean;
}

/** A baked point pushed through the ledger. `dirty` means some edit straddled
 *  the point — the bytes around it were rewritten, so no arithmetic answer
 *  exists and the caller must fall through to its collision policy. */
export interface TransformedPoint {
  point: number;
  dirty: boolean;
}

/**
 * Transform a baked point through every booked edit, oldest first. An edit
 * ending at or left of the point shifts it by the edit's delta (bytes landed
 * before the point move it right; deletions pull it left). An edit starting at
 * or right of the point leaves it alone — an insert exactly AT the point counts
 * as "before" (first branch), so the point stays glued to the bytes it was
 * baked against, not to the foreign bytes that pushed them. An edit straddling
 * the point marks it dirty; the fold continues so a later entry can't shift a
 * garbage point back into plausibility unnoticed, but dirty never clears.
 */
export function transformPoint(point: number, edits: readonly ObservedEdit[]): TransformedPoint {
  let p = point;
  let dirty = false;
  for (const e of edits) {
    const delta = e.textLength - e.rangeLength;
    if (e.offset + e.rangeLength <= p && !(e.rangeLength === 0 && e.offset === p && !e.self)) {
      // Wholly left of the point — but a FOREIGN zero-length insert exactly
      // AT the point is the ambiguous case (whose bytes come first?): treat
      // it as "at", not "before", and leave the point for the context gate.
      // Our own insert there is the step sequence's output and always
      // precedes later steps, so it shifts like any upstream edit.
      p += delta;
    } else if (e.offset >= p) {
      // At or right of the point — the point's bytes didn't move.
    } else {
      dirty = true;
    }
    // A point pushed left of the anchor has entered the corridor where
    // before-anchor edits are absorbed by the window shift and never booked —
    // their deltas can no longer be attributed to it, so no clean arithmetic
    // answer exists there (the re-hunt's residual 2: a before-anchor delete
    // moved a negative-rel point 10 bytes wrong, clean). Fail to collision.
    if (p < 0) dirty = true;
  }
  return { point: p, dirty };
}

/** The live window a symbol occupies (mirrors replay.ts's SymbolWindow — the
 *  ledger can't import it without dragging the tree-sitter surface along). */
export interface Window {
  anchorOffset: number;
  symbolLen: number;
}

/**
 * Convert one document-coordinate change event into a symbol-relative ledger
 * entry, or null when the window's own anchor shift already absorbs it — an
 * edit ending before the anchor moves the anchor, not the relative offsets.
 * SELF changes book even when they touch the anchor exactly: the positional
 * self-filter skips shiftWindow, so a self insert at relative 0 that also
 * escaped the ledger would be tracked by nobody (the hunt's 5a — every later
 * point went clean-stale by the insert's length).
 *
 * A straddle of the window start books at its TRUE (negative) offset; the
 * transform's arithmetic handles it, and a point at relative 0 then reads as
 * straddled — dirty — instead of drifting clean when the straddle is later
 * undone (hunt 3e/3f). There is deliberately NO window-end gate: shiftWindow's
 * end drifts when out-of-window edits get charged to it, and a nulled inside
 * edit is a wrong clean point (hunt 1b); an over-booked entry right of every
 * baked point is provably a no-op.
 */
export function bookObserved(
  w: Window,
  c: { rangeOffset: number; rangeLength: number; textLength: number },
  self = false,
): ObservedEdit | null {
  // SELF changes book unconditionally: the self filter skips shiftWindow, so
  // nothing else can absorb them — a nulled self booking is always a hole
  // (the re-hunt's residual 1: our accept LEFT of the anchor, at a point a
  // straddle had legitimately pushed negative, was tracked by nobody and left
  // every later point clean-stale). Foreign edits ending at or before the
  // anchor stay null — the anchor shift absorbs those.
  if (!self && c.rangeOffset + c.rangeLength <= w.anchorOffset) return null;
  return {
    offset: c.rangeOffset - w.anchorOffset,
    rangeLength: c.rangeLength,
    textLength: c.textLength,
    ...(self ? { self } : {}),
  };
}
