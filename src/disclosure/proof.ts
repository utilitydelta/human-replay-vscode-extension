// Dual-sided context proof for pure inserts — the one op shape with no bytes
// of its own to validate (`originalText === ""`), which is exactly where the
// live incident landed 175 bytes stale, splitting a comment word and an
// indent, with every leg silent. From here on an insert leg LANDS only where
// both sides ratify the point:
//
//   left  — bytes from the NEW source (the landed prefix), line-start
//           anchored, extended a whole line at a time until unique in the new
//           source (cap 8). New-coords on purpose: an earlier hunk that edits
//           the attach line makes old-coords context false-collide (spike-a2).
//   right — the rest of the attach line plus the next full line from the OLD
//           source: the unlanded tail the insert must sit flush against.
//           Zero happy-path rejections across the 198-insert corpus census.
//
// A blank side (a no-left-bytes insert, an end-of-symbol append staring at
// nothing) can't ratify by bytes; those get the positional rule "point equals
// symbol end". A bare "collide when context is non-unique in the live buffer"
// rule is rejected — it false-collides 8 of 198 happy-path inserts (one
// context occurs 2693 times); uniqueness is demanded only where a leg actually
// searches (the content leg). Pure byte arithmetic throughout — model-free.

import { ObservedEdit, transformPoint } from "./ledger";

export interface InsertProof {
  left: string;
  right: string;
}

const LEFT_CTX_CAP_LINES = 8;

// Occurrences of `ctx` in `hay` that begin at a line start — the only
// positions a line-start-anchored context may claim.
function lineStartCount(hay: string, ctx: string): number {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(ctx, i)) >= 0) {
    if (i === 0 || hay[i - 1] === "\n") n++;
    i += 1;
  }
  return n;
}

/** Left context for an insert at `point` in `src` (new coords): from the line
 *  start to the point (mid-line attach keeps the prefix shape), whole lines
 *  prepended until the context is unique in `src` or the cap. Whitespace-only
 *  never counts as unique. May return a non-unique (capped) or blank context —
 *  the arithmetic leg checks it positionally; only the content leg re-demands
 *  uniqueness, against the live buffer. */
export function bakeLeftContext(src: string, point: number): string {
  let start = src.lastIndexOf("\n", point - 2) + 1;
  let lines = 1;
  for (;;) {
    const ctx = src.slice(start, point);
    if (ctx.trim() !== "" && lineStartCount(src, ctx) === 1) return ctx;
    if (start === 0 || lines >= LEFT_CTX_CAP_LINES) return ctx;
    start = src.lastIndexOf("\n", start - 2) + 1;
    lines++;
  }
}

/** Right context for an insert whose old-coords point is `opStart`: the rest
 *  of the attach line plus the next full line of `src` (old coords) — the
 *  unlanded tail the inserted bytes must sit flush against. */
export function bakeRightContext(src: string, opStart: number): string {
  const nl = src.indexOf("\n", opStart);
  if (nl < 0) return src.slice(opStart);
  const nl2 = src.indexOf("\n", nl + 1);
  return src.slice(opStart, nl2 < 0 ? src.length : nl2 + 1);
}

/** Bake proofs onto every pure insert of an ascending-ordered op list. The
 *  left side reads NEW coordinates (baked start plus the deltas of every op
 *  before this one — the buffer shape at this op's own resolve time on the
 *  happy path); the right side reads the op's OLD start. */
export function bakeInsertProofs<T extends { start: number; end: number; replacement: string; originalText: string; proof?: InsertProof }>(
  steps: T[],
  oldSrc: string,
  newSrc: string,
): T[] {
  let delta = 0;
  for (const s of steps) {
    if (s.originalText === "") {
      const point = s.start + delta;
      s.proof = { left: bakeLeftContext(newSrc, point), right: bakeRightContext(oldSrc, s.start) };
    }
    delta += s.replacement.length - (s.end - s.start);
  }
  return steps;
}

function blank(s: string): boolean {
  return s.trim() === "";
}

/** Both sides ratify `p` in the live buffer, or the leg does not land. A blank
 *  side ratifies positionally instead. Blank left: a symbol boundary (the
 *  corpus' doc-comment-above-a-const shapes), or any line start when the
 *  right side carries real bytes — a file that opens with blank lines puts an
 *  insert's point past nothing but whitespace, and demanding a boundary there
 *  false-collided an untouched happy path; the non-blank right side is the
 *  ratifying evidence. Blank right: the end-of-symbol append staring at
 *  nothing — boundary only. */
export function proofOk(symText: string, p: number, proof: InsertProof): boolean {
  const rightBlank = blank(proof.right);
  const leftOk = blank(proof.left)
    ? p === 0 || p === symText.length || (!rightBlank && symText[p - 1] === "\n")
    : p >= proof.left.length &&
      symText.slice(p - proof.left.length, p) === proof.left &&
      (p === proof.left.length || symText[p - proof.left.length - 1] === "\n");
  if (!leftOk) return false;
  return rightBlank ? p === 0 || p === symText.length : symText.slice(p, p + proof.right.length) === proof.right;
}

/** Why a pure insert did NOT land — the forensic line for the output channel.
 *  Recomputes the legs cheaply; called only after resolveInsertPoint returned
 *  null, so the next incident's log names the failed leg instead of a bare
 *  "collision". */
export function explainInsertCollision(
  symText: string,
  step: { start: number; proof?: InsertProof },
  ledger: readonly ObservedEdit[],
): string {
  const proof = step.proof;
  if (!proof) return "no proof baked";
  const t = transformPoint(step.start, ledger);
  const p = t.point;
  const leftState = blank(proof.left)
    ? "blank"
    : p >= proof.left.length && symText.slice(p - proof.left.length, p) === proof.left
      ? "ok"
      : "mismatch";
  const rightState = blank(proof.right) ? "blank" : symText.slice(p, p + proof.right.length) === proof.right ? "ok" : "mismatch";
  const arith = t.dirty
    ? "ledger dirty (an edit straddled the point)"
    : `proof refused point ${p} (left ${leftState}, right ${rightState})`;
  // indexOf("") never returns -1 (past the end it returns length), so a blank
  // left context must never enter the counting loop — it spins the extension
  // host forever, and blank-left is every file-walk block segment's shape.
  let n = 0;
  if (!blank(proof.left)) {
    let i = 0;
    while ((i = symText.indexOf(proof.left, i)) >= 0) {
      if (i === 0 || symText[i - 1] === "\n") n++;
      i += 1;
    }
  }
  const content = blank(proof.left) ? "content: no left bytes to search" : `content: ${n} line-start match(es)`;
  return `arith: ${arith}; ${content}`;
}

/**
 * Resolve a pure insert's landing point, every leg gated by the dual proof:
 *
 *   1. arithmetic — the baked old-coords start transformed through the ledger
 *      (self accepts and foreign edits alike, arrival-ordered). Skipped when
 *      an edit straddled the point (dirty): no arithmetic answer exists.
 *   2. structural — the caller's tree-resolved candidate, same gate.
 *   3. content — the left context re-found in the live buffer (line-start
 *      anchored, exactly once), right side ratifying the match end, and the
 *      candidate bounded by the frontier: everything right of the transformed
 *      point is unlanded OLD tail, so a candidate beyond it sits in doomed
 *      bytes (the doomed-tail doppelganger) — reject. A dirty ledger has no
 *      trustworthy frontier, so the content leg never lands on one.
 *
 * Null means collision — surface to the human, never guess.
 */
export function resolveInsertPoint(
  symText: string,
  step: { start: number; proof?: InsertProof },
  ledger: readonly ObservedEdit[],
  structuralPoint: number | null,
): number | null {
  const proof = step.proof;
  if (!proof) return null; // an unproven insert never lands
  const t = transformPoint(step.start, ledger);
  if (!t.dirty && proofOk(symText, t.point, proof)) return t.point;
  if (structuralPoint !== null && proofOk(symText, structuralPoint, proof)) return structuralPoint;
  if (blank(proof.left) || t.dirty) return null;
  let n = 0;
  let first = -1;
  let i = 0;
  while ((i = symText.indexOf(proof.left, i)) >= 0) {
    if (i === 0 || symText[i - 1] === "\n") {
      n++;
      if (first < 0) first = i;
    }
    i += 1;
  }
  if (n !== 1) return null;
  const cand = first + proof.left.length;
  if (cand > t.point) return null;
  const rightOk = blank(proof.right) ? cand === symText.length : symText.slice(cand, cand + proof.right.length) === proof.right;
  return rightOk ? cand : null;
}
