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
import { findItemByName, leadingTriviaStart, namedChildren, SyntaxNode } from "./walk";
import { headerOf } from "./insertion";

/** A named item's exact bytes (leading doc-comments/attributes included), or
 *  undefined when the item isn't in `text`. */
export function extractSymbol(text: string, symbol: string, spec: LanguageSpec = RUST): string | undefined {
  const node = findItemByName(parseRoot(text, spec) as unknown as SyntaxNode, text, symbol, spec);
  return node ? text.slice(leadingTriviaStart(text, node.startIndex, spec), node.endIndex) : undefined;
}

export type DeleteVerdict =
  | { landed: true; bySpot?: true }
  | { landed: false; strike: string; at: number; candidates: number };

/** Which item a delete step removes. An item is known by where it sits: the
 *  headers of the containers around it plus its name, so a free `fault` and
 *  `SlotScan::fault` are different items. Bytes can't be the key: the item
 *  that stays may not hold its end-state bytes yet (a later modify, a line the
 *  human kept), and striking it deletes work the end state needs. At each spot
 *  the target items the sandbox lacks are the candidates: byte-equal items
 *  pair off first, then the sandbox's remaining items there keep as many
 *  target items. More leftovers than kept slots, with any slot left, is a coin
 *  flip: every leftover is a candidate and `candidates` says how many. No
 *  candidate means the delete has landed; `bySpot` says a target item that
 *  differs from the sandbox was kept only for where it sits. A container is
 *  known by its identity (kind and name, or the language's own key), not its
 *  header text, which a later modify of the container may still change. An unreadable target holds no items;
 *  a missing sandbox holds none either, so every target item is a candidate.
 *  `at` is where the strike starts in the target: the strike range runs from
 *  the cursor, so the cursor must park there and nowhere else. */
export function deleteVerdict(
  targetText: string | undefined,
  sandboxText: string | undefined,
  symbol: string,
  spec: LanguageSpec = RUST,
): DeleteVerdict {
  const targetItems = targetText === undefined ? [] : locatedItems(targetText, symbol, spec);
  const sandboxItems = sandboxText === undefined ? [] : locatedItems(sandboxText, symbol, spec);
  const candidates: LocatedItem[] = [];
  let bySpot = false;
  for (const spot of new Set(targetItems.map((item) => item.spot))) {
    const kept = sandboxItems.filter((item) => item.spot === spot).map((item) => item.bytes);
    const leftover = targetItems.filter((item) => {
      if (item.spot !== spot) return false;
      const i = kept.indexOf(item.bytes);
      if (i < 0) return true;
      kept.splice(i, 1);
      return false;
    });
    if (leftover.length > kept.length) candidates.push(...leftover);
    else if (leftover.length > 0) bySpot = true;
  }
  candidates.sort((a, b) => a.at - b.at);
  if (candidates.length > 0) {
    return { landed: false, strike: candidates[0].bytes, at: candidates[0].at, candidates: candidates.length };
  }
  return bySpot ? { landed: true, bySpot: true } : { landed: true };
}

type LocatedItem = { spot: string; bytes: string; at: number };

function containerSpot(node: SyntaxNode, body: SyntaxNode, text: string, spec: LanguageSpec): string {
  const own = spec.containerIdentity?.(node, text);
  if (own !== undefined) return own;
  const name = spec.nameOf(node, text);
  return name === undefined ? headerOf(text, node, body) : `${node.type}:${name}`;
}

// Every item named `symbol`, matches searched inside too: a C# constructor
// `Foo` is its own item inside `class Foo`, not part of the class's bytes.
// Lift wrappers resolve the way findItemByName resolves them.
function locatedItems(text: string, symbol: string, spec: LanguageSpec): LocatedItem[] {
  const items: LocatedItem[] = [];
  (function walk(node: SyntaxNode, headers: string[], lift: SyntaxNode | null): void {
    if (spec.namedItemTypes.has(node.type) && spec.nameOf(node, text) === symbol) {
      const item = lift ?? node;
      const at = leadingTriviaStart(text, item.startIndex, spec);
      items.push({ spot: [...headers, symbol].join("\n"), bytes: text.slice(at, item.endIndex), at });
    }
    const body = spec.containerBody(node);
    const inside = body ? [...headers, containerSpot(node, body, text, spec)] : headers;
    const childLift = spec.liftParents.has(node.type) ? (lift ?? node) : null;
    for (const c of namedChildren(node)) walk(c, inside, childLift);
  })(parseRoot(text, spec) as unknown as SyntaxNode, [], null);
  return items;
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
