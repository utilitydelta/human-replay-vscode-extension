// Resume derivation — pure, headless-testable, model-free (invariant 1: the
// verdict comes from real bytes on both sides, never a guess).
//
// A replay can stop anywhere: mid-guide, mid-step, or in a previous VS Code
// session. The ground truth of "where was I" is not a saved counter — it is the
// per-symbol delta between the target workspace and the sandbox. A step whose
// target symbol is already byte-identical to the sandbox symbol has been landed
// (by a prior replay session or by hand), and a create counts as landed with
// the human's added lines in it; a delete step whose symbol is gone is done. Deriving done-ness from the files means resume survives window reloads,
// out-of-band edits, and even a lost workspaceState.

import { StepAction } from "./guide";
import { parseRoot } from "./diff";
import { LanguageSpec, RUST } from "./language";
import { landedWithAdditions } from "./fileWalk";
import { findItemByName, leadingTriviaStart, SyntaxNode } from "./walk";

/** A named item's exact bytes (leading doc-comments/attributes included), or
 *  undefined when the item isn't in `text`. */
export function extractSymbol(text: string, symbol: string, spec: LanguageSpec = RUST): string | undefined {
  const node = findItemByName(parseRoot(text, spec) as unknown as SyntaxNode, text, symbol, spec);
  return node ? text.slice(leadingTriviaStart(text, node.startIndex, spec), node.endIndex) : undefined;
}

/** Whether a step's outcome is already in the target. Modify and patch land
 *  when the target byte-matches the sandbox. Create and create-file (callers
 *  pass whole-file contents) also land when the target holds every sandbox
 *  line plus whole lines the human added: their base is empty, so an extra
 *  line can't be one the sandbox deleted (landedWithAdditions). Delete lands
 *  when the symbol is gone. A missing sandbox side can never mark a step
 *  landed — no evidence, no verdict. */
export function stepAlreadyLanded(
  action: StepAction,
  targetSymbol: string | undefined,
  sandboxSymbol: string | undefined,
): boolean {
  if (action === "delete") return targetSymbol === undefined;
  if (targetSymbol === undefined || sandboxSymbol === undefined) return false;
  if (action === "create" || action === "create-file") return landedWithAdditions(sandboxSymbol, targetSymbol);
  return targetSymbol === sandboxSymbol;
}
