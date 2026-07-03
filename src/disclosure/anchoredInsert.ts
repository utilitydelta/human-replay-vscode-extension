// Re-anchored insertion for the insert walk's divergence-recovery path.
//
// The happy-path walk (walk.ts) uses baked offsets — fast and byte-exact, but it
// assumes only its own Tabs move the buffer. The moment the human authors their own
// code mid-build those offsets are stale. This module is the recovery primitive:
// given the live symbol text, it re-resolves where the next planned node lands by
// finding its PARENT container and appending at the end of that parent's body —
// proven in spike S11 to survive an additive edit (a sibling the human added just
// pushes the append point down; nothing counts indices, so nothing breaks).
//
// A planned node is addressed by its parent's header text (`ROOT` = the function).
// A missing parent returns null — the collision signal the panel surfaces so the
// human decides, never a guess. Model-free, like the rest of disclosure.

import { SyntaxNode, descendable, findWalkStart, namedChildren } from "./walk";
import { parseRoot } from "./diff";
import { LanguageSpec, RUST } from "./language";

const unwrap = (n: SyntaxNode): SyntaxNode =>
  n.type === "expression_statement" && n.namedChildCount === 1 ? n.namedChild(0)! : n;

// Column (0-based) of byte offset `i` on its line.
function colOf(src: string, i: number): number {
  let c = 0;
  for (let k = i - 1; k >= 0 && src[k] !== "\n"; k--) c++;
  return c;
}

// The container node whose header text matches `key` ("ROOT" = the function).
function findContainer(symbolText: string, key: string, spec: LanguageSpec): SyntaxNode | null {
  const root = parseRoot(symbolText, spec);
  if (key === "ROOT") return findWalkStart(root, spec);
  let found: SyntaxNode | null = null;
  (function scan(node: SyntaxNode): void {
    if (found) return;
    const u = unwrap(node);
    const d = descendable(u, spec);
    // Compare the candidate's FULL header (start → its block), not a length-prefix —
    // otherwise `if foo` would match `if foobar`. Duplicate identical sibling headers
    // resolve to the first (a known limit; the planned tree usually disambiguates).
    if (d && symbolText.slice(u.startIndex, d.block.startIndex).trim() === key) {
      found = u;
      return;
    }
    for (const c of namedChildren(node)) scan(c);
  })(root);
  return found;
}

/**
 * The container key of the INNERMOST descendable block whose body holds `offset` — the
 * same header-text key the walk plan assigns that container's children as their
 * `parentKey` (walk.ts `childKey`). The recovery ghost inserts the next planned node at
 * the cursor, which is only structurally right when the cursor sits in that node's own
 * parent. When the next node belongs to an ANCESTOR — the walk is climbing back out,
 * e.g. a function's tail expression after a nested loop — the cursor is still deep
 * inside a child block, so the caller compares this against the node's parentKey and,
 * on a mismatch, declines the cursor-insert so `appendEdit` places it structurally.
 * Null when the cursor is in no container (or nothing is built yet).
 */
export function innermostContainerKey(symbolText: string, offset: number, spec: LanguageSpec = RUST): string | null {
  const root = parseRoot(symbolText, spec);
  let key: string | null = null;
  let bestSpan = Infinity;
  (function scan(node: SyntaxNode): void {
    const u = unwrap(node);
    const d = descendable(u, spec);
    if (d && offset > d.block.startIndex && offset < d.block.endIndex) {
      const span = d.block.endIndex - d.block.startIndex;
      if (span < bestSpan) {
        bestSpan = span;
        key = symbolText.slice(u.startIndex, d.block.startIndex).trim();
      }
    }
    for (const c of namedChildren(node)) scan(c);
  })(root);
  return key;
}

/**
 * Every container key on the cursor's ancestor chain, innermost first — the
 * containers whose body holds `offset`. The climb-out eligibility test: a
 * planned node whose parent is an ANCESTOR of the cursor's container places
 * structurally (appendEdit at that parent's frontier) with no ambiguity, so
 * Tab may act without the caret moving first.
 */
export function containerKeyChain(symbolText: string, offset: number, spec: LanguageSpec = RUST): string[] {
  const root = parseRoot(symbolText, spec);
  const hits: { span: number; key: string }[] = [];
  (function scan(node: SyntaxNode): void {
    const u = unwrap(node);
    const d = descendable(u, spec);
    if (d && offset > d.block.startIndex && offset < d.block.endIndex) {
      hits.push({ span: d.block.endIndex - d.block.startIndex, key: symbolText.slice(u.startIndex, d.block.startIndex).trim() });
    }
    for (const c of namedChildren(node)) scan(c);
  })(root);
  return hits.sort((a, b) => a.span - b.span).map((h) => h.key);
}

/** A region-relative replace that appends `nodeText` into a parent's body. */
export interface AppendEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Resolve the edit that appends `nodeText` at the end of the body of the container
 * identified by `parentKey`, in `symbolText` coordinates. Returns null when the
 * parent can't be found (collision — the caller must surface, never guess).
 */
export function appendEdit(symbolText: string, parentKey: string, nodeText: string, spec: LanguageSpec = RUST): AppendEdit | null {
  const container = findContainer(symbolText, parentKey, spec);
  if (!container) return null;
  const d = descendable(container, spec);
  if (!d) return null;
  const block = d.block;
  const close = block.endIndex - 1; // the `}`
  const childIndent = colOf(symbolText, container.startIndex) + spec.indentWidth;
  const closeIndent = colOf(symbolText, container.startIndex);

  // Drop all whitespace before the close brace (a baked blank line, double blanks,
  // CRLF), then write the child on its own indented line and re-indent the close.
  let cut = close;
  while (cut > 0 && /\s/.test(symbolText[cut - 1])) cut--;
  // Indent EVERY line of the node, not just the first — a container shell carries
  // its own `\n}` that must sit at the child indent, not column 0.
  const pad = " ".repeat(childIndent);
  const indented = nodeText
    .split("\n")
    .map((l, i) => (i === 0 ? l : `${pad}${l}`))
    .join("\n");
  const text = `\n${pad}${indented}\n${" ".repeat(closeIndent)}`;
  return { start: cut, end: close, text };
}

/** Apply an AppendEdit to the symbol text. */
export function applyAppend(symbolText: string, edit: AppendEdit): string {
  return symbolText.slice(0, edit.start) + edit.text + symbolText.slice(edit.end);
}
