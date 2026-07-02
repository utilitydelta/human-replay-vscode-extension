// Surgical vs rewrite: how to replay a changed symbol.
//
// When the agent barely touched a function, the diff is the signal — show the few
// lines that changed, surgically. When it reworked most of the function, the diff
// is noise: a pile of disjoint hunks the human rubber-stamps without ever reading
// the new function whole. There the better replay is to clear the old symbol and
// descend-and-fill the new one from scratch — the comprehension gate works on the
// new algorithm, not on fragments.
//
// The AST gives the cutover for free. Two signals, both off the diff:
//   - survival: fraction of the old symbol's bytes left unchanged.
//   - skeletonChange: *how much* of the control-flow shape (nesting of
//     for/if/while/loop) moved — a fraction, not a boolean. Adding one `if` to a
//     four-block function moved a quarter of the skeleton; collapsing a loop to an
//     iterator chain moved most of it. A small structural touch is still surgical.
// Either enough skeleton movement or low survival routes to rewrite. Both
// thresholds are feel calls, tuned at the keyboard; the signals are not.

import { SyntaxNode, descendable, findFunction, namedChildren } from "./walk";
import { diffSymbols, parseRoot } from "./diff";

// Below this fraction of surviving bytes, a surgical replay is more noise than
// signal — clear and re-disclose. Tunable by feel.
export const SURGICAL_FLOOR = 0.5;

// Above this fraction of the control-flow skeleton moved, the restructure is the
// story — clear and re-disclose the new shape whole. Below it, even a real
// structural touch (one added branch) stays surgical. Tunable by feel.
export const SKELETON_FLOOR = 0.5;

export interface ReplayPlan {
  /** Fraction of the old symbol's bytes left unchanged (0..1). */
  survival: number;
  /** Count of disjoint changed ops — fragmentation. */
  hunks: number;
  /** Fraction of the control-flow skeleton that moved (0..1). */
  skeletonChange: number;
  /** Convenience: did the control-flow shape change at all (skeletonChange > 0)? */
  skeletonChanged: boolean;
  strategy: "surgical" | "rewrite";
}

// Pre-order sequence of control-flow node *types* — container types only, no
// signature or leaf text, flattened so two skeletons can be compared by how far
// apart they are, not just whether they differ. Descends only into descendable
// blocks; signature and leaf edits do not change it (the survival ratio catches
// those).
function skeletonSeq(src: string): string[] {
  const fn = findFunction(parseRoot(src));
  if (!fn) return [];
  const seq: string[] = [];
  (function walk(node: SyntaxNode): void {
    const d = descendable(node);
    if (!d) return;
    seq.push(d.node.type === "function_item" ? "fn" : d.node.type);
    for (const c of namedChildren(d.block)) walk(c);
  })(fn);
  return seq;
}

// Levenshtein over two token sequences — the count of container nodes inserted,
// deleted, or substituted to turn one skeleton into the other.
function editDistance(a: string[], b: string[]): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(prev[j], prev[j - 1], diag);
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Fraction of the control-flow skeleton that moved between old and new (0..1). */
function skeletonChangeFraction(oldSrc: string, newSrc: string): number {
  const a = skeletonSeq(oldSrc);
  const b = skeletonSeq(newSrc);
  const span = Math.max(a.length, b.length);
  return span === 0 ? 0 : editDistance(a, b) / span;
}

/** Decide how to replay `diff(old, new)`: surgical edits or clear-and-rewrite. */
export function classifyReplay(oldSrc: string, newSrc: string): ReplayPlan {
  const { ops, stable } = diffSymbols(oldSrc, newSrc);
  const stableBytes = stable.reduce((sum, [a, b]) => sum + (b - a), 0);
  const survival = oldSrc.length ? stableBytes / oldSrc.length : 0;
  const skeletonChange = skeletonChangeFraction(oldSrc, newSrc);
  const strategy =
    skeletonChange >= SKELETON_FLOOR || survival < SURGICAL_FLOOR ? "rewrite" : "surgical";
  return { survival, hunks: ops.length, skeletonChange, skeletonChanged: skeletonChange > 0, strategy };
}
