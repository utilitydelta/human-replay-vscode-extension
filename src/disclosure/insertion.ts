// Pure placement logic for the guide runner's create path — vscode-free so it
// can be proven headless.
//
// A created symbol that is top-level in the sandbox lands at end-of-file. A
// created symbol that is NESTED (a method in an impl/class, an item in a mod)
// must land inside the matching container in the target — appending it at
// end-of-file produces code outside its parent, which for a `&mut self` method
// doesn't even compile. The container and the landing spot are computed from
// real bytes on both sides (invariant 1): the sandbox says which container the
// symbol belongs to and which sibling precedes it; the target says where that
// container and sibling live today. When the container can't be found in the
// target, the plan is `blocked` — surfaced to the human, never guessed.

import { LanguageSpec } from "./language";
import { SyntaxNode, namedChildren } from "./walk";
import { parseRoot } from "./diff";

/** Newlines to append to `text` so end-of-file is a blank, separated line. */
export function separatorToInsert(text: string): string {
  if (text.replace(/\s/g, "").length === 0) return ""; // empty/whitespace file: land as-is
  const trailingNewlines = text.match(/\n*$/)?.[0].length ?? 0;
  return "\n".repeat(Math.max(0, 2 - trailingNewlines));
}

export type CreatePlacement =
  /** Replace [start, end) of the target with `scaffold`, then park the cursor at
   *  `cursorAt` (post-edit offset, on a fresh line at the child indent). */
  | { kind: "container"; start: number; end: number; scaffold: string; cursorAt: number; container: string }
  /** The symbol is top-level in the sandbox — end-of-file is its real home. */
  | { kind: "top-level" }
  /** Nested in the sandbox, but the container can't be resolved in the target. */
  | { kind: "blocked"; reason: string };

// Column (0-based) of byte offset `i` on its line.
function colOf(src: string, i: number): number {
  let c = 0;
  for (let k = i - 1; k >= 0 && src[k] !== "\n"; k--) c++;
  return c;
}

// Offset of the end of the line containing `i` (the `\n`, or text end).
function lineEnd(text: string, i: number): number {
  const nl = text.indexOf("\n", i);
  return nl < 0 ? text.length : nl;
}

// A container's header for cross-file matching: bytes from its start to its body,
// whitespace-normalized so a wrapped header still matches. Exact-equality beyond
// that — a header that drifted between sandbox and target is a real conflict.
function headerOf(text: string, container: SyntaxNode, body: SyntaxNode): string {
  return text.slice(container.startIndex, body.startIndex).replace(/\s+/g, " ").trim();
}

// The item's name, looking through a lift wrapper (decorated_definition,
// export_statement) the same way extraction does.
function itemNameOf(node: SyntaxNode, src: string, spec: LanguageSpec): string | undefined {
  const own = spec.nameOf(node, src);
  if (own !== undefined) return own;
  if (!spec.liftParents.has(node.type)) return undefined;
  for (const c of namedChildren(node)) {
    const n = spec.nameOf(c, src);
    if (n !== undefined) return n;
  }
  return undefined;
}

// Root-to-item path of the first named item matching `name` (pre-order, same
// first-match rule as findItemByName). The path is what placement needs and the
// minimal SyntaxNode view has no parent pointers.
function pathToItem(root: SyntaxNode, src: string, name: string, spec: LanguageSpec): SyntaxNode[] | null {
  if (spec.namedItemTypes.has(root.type) && spec.nameOf(root, src) === name) return [root];
  for (const c of namedChildren(root)) {
    const p = pathToItem(c, src, name, spec);
    if (p) return [root, ...p];
  }
  return null;
}

// First container in `scope`'s subtree whose header matches, pre-order — the
// same first-match limit findContainer has; real container headers (impl/class
// names) disambiguate in practice.
function findContainerByHeader(
  text: string,
  scope: SyntaxNode,
  header: string,
  spec: LanguageSpec,
): { node: SyntaxNode; body: SyntaxNode } | null {
  const body = spec.containerBody(scope);
  if (body && headerOf(text, scope, body) === header) return { node: scope, body };
  for (const c of namedChildren(scope)) {
    const hit = findContainerByHeader(text, c, header, spec);
    if (hit) return hit;
  }
  return null;
}

/**
 * Where a fresh create step's symbol lands in the target, derived from where it
 * lives in the sandbox. Anchors after the nearest preceding sandbox sibling that
 * already exists in the target (sandbox order, model-free); with no such sibling
 * it lands after the container's last item, and an empty container opens its body.
 */
export function planCreateInsertion(
  targetText: string,
  sandboxText: string,
  symbol: string,
  spec: LanguageSpec,
): CreatePlacement {
  const sandRoot = parseRoot(sandboxText, spec) as unknown as SyntaxNode;
  const path = pathToItem(sandRoot, sandboxText, symbol, spec);
  if (!path) return { kind: "top-level" }; // unresolvable bytes fail loud elsewhere

  const containers = path.slice(0, -1).filter((n) => spec.containerBody(n) !== null);
  if (containers.length === 0) return { kind: "top-level" };

  // Resolve the sandbox container chain in the target, outermost first, each
  // level scoped to the previous match.
  let scope = parseRoot(targetText, spec) as unknown as SyntaxNode;
  let target: { node: SyntaxNode; body: SyntaxNode } | null = null;
  let header = "";
  for (const c of containers) {
    header = headerOf(sandboxText, c, spec.containerBody(c)!);
    target = findContainerByHeader(targetText, scope, header, spec);
    if (!target) return { kind: "blocked", reason: `container \`${header}\` not found in the target file` };
    scope = target.body;
  }

  // The sandbox sibling the item follows: its direct-child wrapper in the
  // innermost container's body.
  const sandBody = spec.containerBody(containers[containers.length - 1])!;
  const item = path[path.length - 1];
  const sibs = namedChildren(sandBody);
  const itemIdx = sibs.findIndex((s) => s.startIndex <= item.startIndex && s.endIndex >= item.endIndex);

  const targetKids = namedChildren(target!.body);
  const byName = new Map<string, SyntaxNode>();
  for (const k of targetKids) {
    const n = itemNameOf(k, targetText, spec);
    if (n !== undefined && !byName.has(n)) byName.set(n, k);
  }
  let anchor: SyntaxNode | undefined;
  for (let i = itemIdx - 1; i >= 0 && !anchor; i--) {
    const n = itemNameOf(sibs[i], sandboxText, spec);
    if (n !== undefined) anchor = byName.get(n);
  }
  anchor ??= targetKids[targetKids.length - 1]; // no named predecessor in the target: land last

  const body = target!.body;
  const braced = targetText[body.endIndex - 1] === "}";
  if (anchor) {
    const at = lineEnd(targetText, anchor.endIndex);
    // A one-line container (`impl X { fn a() {} }`) has no line to land on.
    if (braced && at >= body.endIndex) {
      return { kind: "blocked", reason: `container \`${header}\` is single-line — no landing line for the new symbol` };
    }
    const pad = " ".repeat(colOf(targetText, anchor.startIndex));
    const scaffold = `\n\n${pad}`;
    return { kind: "container", start: at, end: at, scaffold, cursorAt: at + scaffold.length, container: header };
  }

  // Empty body. Brace languages open it; an indent-block body always has at
  // least one statement, so reaching here without a brace is a parse oddity.
  if (!braced) return { kind: "blocked", reason: `container \`${header}\` has an empty body the engine can't open` };
  const childIndent = colOf(targetText, target!.node.startIndex) + spec.indentWidth;
  const closeIndent = colOf(targetText, target!.node.startIndex);
  const open = body.startIndex + 1;
  const scaffold = `\n${" ".repeat(childIndent)}\n${" ".repeat(closeIndent)}`;
  return {
    kind: "container",
    start: open,
    end: body.endIndex - 1,
    scaffold,
    cursorAt: open + 1 + childIndent,
    container: header,
  };
}
