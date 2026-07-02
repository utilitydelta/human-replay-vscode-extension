// Disclosure walk engine.
//
// Turns a sandbox function symbol into an ordered list of disclosure steps for
// node-by-node descent: shape first (header + empty braces), then descend into
// each control-flow block, filling leaves, then back out to siblings.
//
// A step is replayed by the provider as: insert `insert` at the cursor, then
// move the cursor to `cursorOffset` (region-relative), then re-trigger the next
// ghost. The cursor of step i is, by construction, the insertion point of step
// i+1 — so a finished block's last step naturally jumps the cursor back out to
// the parent's next sibling.
//
// Offsets are exact because the walk simulates the build on a growing string.
// Disclosure unit = control-flow blocks only (function/for/while/loop/if without
// else). match arms, closures, if/else, struct literals are leaves: revealed
// whole. See S1 FINDINGS for why that boundary is correct for the fencing demo.

import Parser = require("tree-sitter");
import Rust = require("tree-sitter-rust");

// Minimal structural view of a tree-sitter node — avoids a hard dep on @types.
export interface SyntaxNode {
  type: string;
  startIndex: number;
  endIndex: number;
  namedChildCount: number;
  /** True when the subtree contains an ERROR/MISSING node — the buffer is mid-edit
   *  (incomplete syntax), as opposed to a clean parse the human meant. */
  hasError: boolean;
  namedChild(i: number): SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
}

export interface Step {
  /** Text inserted at the current cursor when this step is accepted. */
  insert: string;
  /** Region-relative offset this step inserts at (the previous step's cursor). */
  insertOffset: number;
  /** Region-relative offset the cursor moves to after the insert. */
  cursorOffset: number;
  /** Descend-into-a-block vs reveal-a-leaf. Container cursors land inside braces. */
  kind: "container" | "leaf";
  /** Header text of the parent container to append into ("ROOT" = the function).
   *  The re-anchor key for divergence recovery (anchoredInsert.ts). */
  parentKey: string;
  /** This node's text with no baked lead — a container shell or a leaf's source.
   *  What the recovery path appends when the baked offset has gone stale. */
  bareText: string;
}

const INDENT = 4;
const sp = (n: number) => " ".repeat(n);

let sharedParser: Parser | null = null;
function parser(): Parser {
  if (!sharedParser) {
    sharedParser = new Parser();
    // tree-sitter-rust ships its own nominal `Language` type; cast across.
    sharedParser.setLanguage(Rust as unknown as Parser.Language);
  }
  return sharedParser;
}

// A control-flow node we descend into, with the block whose interior we open.
// Returns null for leaves (emitted whole).
export function descendable(child: SyntaxNode): { node: SyntaxNode; block: SyntaxNode } | null {
  // Statements wrap their expression: block -> expression_statement -> for/if/...
  let node = child;
  if (child.type === "expression_statement" && child.namedChildCount === 1) {
    node = child.namedChild(0)!;
  }
  switch (node.type) {
    case "function_item":
    case "for_expression":
    case "while_expression":
    case "loop_expression": {
      const block = node.childForFieldName("body");
      return block && block.type === "block" ? { node, block } : null;
    }
    case "if_expression": {
      // if/else can't be modelled by a single open block — reveal it whole.
      if (node.childForFieldName("alternative")) return null;
      const block = node.childForFieldName("consequence");
      return block && block.type === "block" ? { node, block } : null;
    }
    default:
      return null;
  }
}

export function namedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i)!);
  return out;
}

// First function_item in pre-order — the symbol to disclose. Recurses so a fn
// nested in an impl block is found.
export function findFunction(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "function_item") return node;
  for (const c of namedChildren(node)) {
    const f = findFunction(c);
    if (f) return f;
  }
  return null;
}

// The function_item named `name`, in pre-order — where a modify/delete step's
// symbol already lives, so the guide runner can park the cursor on it. `src` is
// the buffer the node indexes into (to read the name field).
export function findFunctionByName(node: SyntaxNode, src: string, name: string): SyntaxNode | null {
  if (node.type === "function_item") {
    const id = node.childForFieldName("name");
    if (id && src.slice(id.startIndex, id.endIndex) === name) return node;
  }
  for (const c of namedChildren(node)) {
    const f = findFunctionByName(c, src, name);
    if (f) return f;
  }
  return null;
}

// Any named Rust item the replay can address by name — not just functions. The diff
// engine is kind-agnostic (it tree-diffs whatever bytes it's handed), so the only
// reason replay was fn-only was this resolver. A struct/enum/const/trait/type alias/
// static/macro/module is just as addressable; methods are `function_item` inside an
// impl, found here too. An impl block has no name field, so it isn't addressable by
// name (its methods are). First match wins — a name reused across items resolves to
// the first (the same caveat as functions; the guide should disambiguate).
const NAMED_ITEM_TYPES = new Set([
  "function_item",
  "struct_item",
  "enum_item",
  "union_item",
  "const_item",
  "static_item",
  "type_item",
  "trait_item",
  "mod_item",
  "macro_definition",
]);

export function findItemByName(node: SyntaxNode, src: string, name: string): SyntaxNode | null {
  if (NAMED_ITEM_TYPES.has(node.type)) {
    const id = node.childForFieldName("name");
    if (id && src.slice(id.startIndex, id.endIndex) === name) return node;
  }
  for (const c of namedChildren(node)) {
    const f = findItemByName(c, src, name);
    if (f) return f;
  }
  return null;
}

// Extend an item's start back over the doc comments and attributes attached above
// it. tree-sitter-rust models outer doc comments (/// //! //) and attributes (#[...])
// as PRECEDING SIBLINGS, not children, so the item node excludes them — and a change
// confined to the comment (a rewrite of the fn's doc) would be invisible to the diff.
// Scan the source upward line by line from the item, absorbing contiguous comment /
// attribute lines, stopping at a blank line (detached) or any code line. Block
// comments are matched by their `/*`…`*/`/`*` line shapes. Line-based so it needs no
// sibling API on the minimal SyntaxNode view.
export function leadingTriviaStart(src: string, itemStart: number): number {
  const isTrivia = (line: string): boolean => {
    const t = line.trim();
    if (t === "") return false; // blank line → the comment block is detached
    return (
      t.startsWith("//") || // /// //! and plain //
      t.startsWith("#[") ||
      t.startsWith("#![") ||
      t.startsWith("/*") ||
      t.startsWith("*") // block-comment continuation / close line
    );
  };
  let result = itemStart;
  let lineStart = src.lastIndexOf("\n", itemStart - 1) + 1; // start of the item's own line
  while (lineStart > 0) {
    const prevLineEnd = lineStart - 1; // the '\n' terminating the previous line
    const prevLineStart = src.lastIndexOf("\n", prevLineEnd - 1) + 1;
    if (!isTrivia(src.slice(prevLineStart, prevLineEnd))) break;
    result = prevLineStart;
    lineStart = prevLineStart;
  }
  return result;
}

/**
 * Compute the disclosure steps for the first function in `src`.
 * Offsets are relative to the start of `src` (region offset 0).
 */
export function computeSteps(src: string): Step[] {
  const root = parser().parse(src).rootNode as unknown as SyntaxNode;
  const fn = findFunction(root);
  if (!fn) throw new Error("no function_item in source");

  // Raw emissions in pre-order: text and the cursor it is inserted at, in the
  // coordinates of the buffer as it exists at that moment. Built by splicing a
  // real string so positions are exact.
  const raw: { insert: string; insertPos: number; kind: Step["kind"]; parentKey: string; bareText: string }[] = [];
  let buffer = "";
  const splice = (pos: number, text: string) => {
    buffer = buffer.slice(0, pos) + text + buffer.slice(pos);
  };

  // Emit `node`'s skeleton beginning at `pos`; `indent` is its line's column;
  // `lead` (newline + indent for non-first siblings) is folded into the step so
  // the provider inserts it at the previous sibling's end. `parentKey` is the
  // header of the container this node lands in (for re-anchored recovery). Returns
  // the position immediately after this node's full skeleton.
  function emit(node: SyntaxNode, pos: number, indent: number, lead: string, parentKey: string): number {
    const d = descendable(node);
    if (!d) {
      const bareText = src.slice(node.startIndex, node.endIndex);
      const text = lead + bareText;
      splice(pos, text);
      raw.push({ insert: text, insertPos: pos, kind: "leaf", parentKey, bareText });
      return pos + text.length;
    }
    const header = src.slice(d.node.startIndex, d.block.startIndex + 1); // ends with `{`
    const inner = indent + INDENT;
    const body = lead + header + "\n" + sp(inner) + "\n" + sp(indent) + "}";
    splice(pos, body);
    // The recovery shell (no baked lead/blank line): `header {\n}`.
    const bareText = src.slice(d.node.startIndex, d.block.startIndex + 1) + "\n}";
    raw.push({ insert: body, insertPos: pos, kind: "container", parentKey, bareText });

    // This container's own key, for its children to re-anchor against.
    const childKey = src.slice(d.node.startIndex, d.block.startIndex).trim();
    const blankLine = pos + lead.length + header.length + 1 + inner; // cursor inside braces
    const kids = namedChildren(d.block);
    if (kids.length === 0) return pos + body.length;

    let cursor = emit(kids[0], blankLine, inner, "", childKey);
    for (let i = 1; i < kids.length; i++) {
      cursor = emit(kids[i], cursor, inner, "\n" + sp(inner), childKey);
    }
    // Tail left after the children: "\n" + close-indent + "}".
    return cursor + 1 + indent + 1;
  }

  emit(fn, 0, 0, "", "ROOT");

  // cursorOffset of step i = insertPos of step i+1 (the next insertion point);
  // last step's cursor lands at the end of its own insert.
  return raw.map((r, i) => ({
    insert: r.insert,
    kind: r.kind,
    parentKey: r.parentKey,
    bareText: r.bareText,
    insertOffset: r.insertPos,
    cursorOffset: i + 1 < raw.length ? raw[i + 1].insertPos : r.insertPos + r.insert.length,
  }));
}
