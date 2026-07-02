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

// The file's line ending — scaffolds and separators must match it, or a CRLF
// target ends up with mixed endings.
function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Newlines to append to `text` so end-of-file is a blank, separated line. */
export function separatorToInsert(text: string): string {
  if (text.replace(/\s/g, "").length === 0) return ""; // empty/whitespace file: land as-is
  const trailingNewlines = (text.match(/(?:\r?\n)*$/)?.[0].match(/\n/g) ?? []).length;
  return eolOf(text).repeat(Math.max(0, 2 - trailingNewlines));
}

export type CreatePlacement =
  /** Replace [start, end) of the target with `scaffold`, then park the cursor at
   *  `cursorAt` (post-edit offset, on a fresh line at column `indent`). */
  | { kind: "container"; start: number; end: number; scaffold: string; cursorAt: number; indent: number; container: string }
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

// Offset of the end of the line containing `i` — before its `\r\n`/`\n`, or text end.
function lineEnd(text: string, i: number): number {
  const nl = text.indexOf("\n", i);
  if (nl < 0) return text.length;
  return text[nl - 1] === "\r" ? nl - 1 : nl;
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

// The container in `scope`'s subtree whose header matches, disambiguated by
// member overlap: when the same header appears more than once (Rust allows many
// `impl X` blocks in one file), the candidate sharing the most direct-child item
// names with the sandbox container wins — still bytes on both sides, no guess.
// Ties resolve to the first in file order.
function findContainerByHeader(
  text: string,
  scope: SyntaxNode,
  header: string,
  siblingNames: ReadonlySet<string>,
  spec: LanguageSpec,
): { node: SyntaxNode; body: SyntaxNode } | null {
  let best: { node: SyntaxNode; body: SyntaxNode } | null = null;
  let bestScore = -1;
  (function scan(node: SyntaxNode): void {
    const body = spec.containerBody(node);
    if (body && headerOf(text, node, body) === header) {
      let score = 0;
      for (const k of namedChildren(body)) {
        const n = itemNameOf(k, text, spec);
        if (n !== undefined && siblingNames.has(n)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = { node, body };
      }
    }
    for (const c of namedChildren(node)) scan(c);
  })(scope);
  return best;
}

// Names of a container body's direct child items (through lift wrappers).
function memberNames(body: SyntaxNode, src: string, spec: LanguageSpec): Set<string> {
  const names = new Set<string>();
  for (const k of namedChildren(body)) {
    const n = itemNameOf(k, src, spec);
    if (n !== undefined) names.add(n);
  }
  return names;
}

/**
 * Where a fresh create step's symbol lands in the target, derived from where it
 * lives in the sandbox. Anchors after the nearest preceding sandbox sibling that
 * already exists in the target (sandbox order, model-free); with no such sibling
 * it lands after the container's last item, and an empty container opens its
 * body. The file root is a container like any other, so a top-level symbol also
 * lands in sandbox order among its live siblings; `top-level` (end-of-file) is
 * the fallback when the root has no usable anchor.
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
  const targetRoot = parseRoot(targetText, spec) as unknown as SyntaxNode;
  const item = path[path.length - 1];

  // Resolve the sandbox container chain in the target, outermost first, each
  // level scoped to the previous match and disambiguated by member overlap.
  let target: { node: SyntaxNode; body: SyntaxNode } | null = null;
  let header = "";
  {
    let scope = targetRoot;
    for (const c of containers) {
      const cBody = spec.containerBody(c)!;
      header = headerOf(sandboxText, c, cBody);
      target = findContainerByHeader(targetText, scope, header, memberNames(cBody, sandboxText, spec), spec);
      if (!target) return { kind: "blocked", reason: `container \`${header}\` not found in the target file` };
      scope = target.body;
    }
  }
  const atRoot = target === null;
  const body = atRoot ? targetRoot : target!.body;
  const sandBody = atRoot ? sandRoot : spec.containerBody(containers[containers.length - 1])!;
  const label = atRoot ? "top level" : header;

  // The sandbox sibling the item follows: its direct-child wrapper in the
  // container's body.
  const sibs = namedChildren(sandBody);
  const itemIdx = sibs.findIndex((s) => s.startIndex <= item.startIndex && s.endIndex >= item.endIndex);

  // At the root the item must BE a direct child (or its lift wrapper) — a symbol
  // nested deeper with no container mapping (a markdown subsection, an item in a
  // fn) has no honest root-level spot; end-of-file keeps the miss visible.
  if (atRoot && itemIdx >= 0) {
    const holder = sibs[itemIdx];
    const isItem = holder.startIndex === item.startIndex && holder.endIndex === item.endIndex;
    if (!isItem && !spec.liftParents.has(holder.type)) return { kind: "top-level" };
  }

  const targetKids = namedChildren(body);
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
  if (!atRoot) anchor ??= targetKids[targetKids.length - 1]; // no named predecessor: land last
  if (atRoot && !anchor) return { kind: "top-level" }; // root fallback stays end-of-file

  const eol = eolOf(targetText);
  const braced = !atRoot && targetText[body.endIndex - 1] === "}";
  if (anchor) {
    // Some grammars (markdown sections) extend a node's span over its trailing
    // blank line, putting endIndex at the START of the next sibling's line — back
    // off to the last content byte so the landing line is the anchor's own.
    let e = anchor.endIndex;
    while (e > anchor.startIndex && /\s/.test(targetText[e - 1])) e--;
    const at = lineEnd(targetText, e);
    // A one-line container (`impl X { fn a() {} }`) has no line to land on.
    if (braced && at >= body.endIndex) {
      return { kind: "blocked", reason: `container \`${header}\` is single-line — no landing line for the new symbol` };
    }
    const indent = colOf(targetText, anchor.startIndex);
    const scaffold = `${eol}${eol}${" ".repeat(indent)}`;
    return { kind: "container", start: at, end: at, scaffold, cursorAt: at + scaffold.length, indent, container: label };
  }

  // Empty body. Brace languages open it; an indent-block body always has at
  // least one statement, so reaching here without a brace is a parse oddity.
  if (!braced) return { kind: "blocked", reason: `container \`${header}\` has an empty body the engine can't open` };
  const childIndent = colOf(targetText, target!.node.startIndex) + spec.indentWidth;
  const closeIndent = colOf(targetText, target!.node.startIndex);
  const open = body.startIndex + 1;
  const scaffold = `${eol}${" ".repeat(childIndent)}${eol}${" ".repeat(closeIndent)}`;
  return {
    kind: "container",
    start: open,
    end: body.endIndex - 1,
    scaffold,
    cursorAt: open + eol.length + childIndent,
    indent: childIndent,
    container: label,
  };
}
