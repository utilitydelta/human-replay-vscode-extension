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
// Offsets are exact because the walk simulates the build on a growing string,
// and layout comes from source bytes (leads, blank lines, close braces are all
// slices of the input). Disclosure units = control-flow blocks (function/for/
// while/loop/if without else) and item containers (class/impl/mod — members
// disclose one by one). match arms, closures, if/else, struct literals are
// leaves: revealed whole.

import { LanguageSpec, RUST, parserFor } from "./language";

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

// A control-flow node we descend into, with the block whose interior we open.
// Returns null for leaves (emitted whole). Per-language shapes live in the
// language registry; this delegates.
export function descendable(child: SyntaxNode, spec: LanguageSpec = RUST): { node: SyntaxNode; block: SyntaxNode } | null {
  return spec.descendable(child);
}

export function namedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i)!);
  return out;
}

// First function-shaped node in pre-order — the symbol to disclose. Recurses so
// a method nested in an impl/class is found.
export function findFunction(node: SyntaxNode, spec: LanguageSpec = RUST): SyntaxNode | null {
  if (spec.functionTypes.has(node.type)) return node;
  for (const c of namedChildren(node)) {
    const f = findFunction(c, spec);
    if (f) return f;
  }
  return null;
}

// First node the walk can open — a function OR an item container (class, impl,
// mod). The walk's entry point: a created class discloses shape-first exactly
// like a function does, members instead of statements.
export function findWalkStart(node: SyntaxNode, spec: LanguageSpec = RUST): SyntaxNode | null {
  if (spec.descendable(node)) return node;
  for (const c of namedChildren(node)) {
    const f = findWalkStart(c, spec);
    if (f) return f;
  }
  return null;
}

// The walk region's live text — from the region start through the end of the
// walked node — or undefined when there is NO VERDICT: no walkable node, or a
// dirty parse. Tree-sitter's error recovery absorbs the human's own (possibly
// not-yet-valid) code into neighboring nodes, so every container key computed
// from an erroring tree is poison — a struct the grammar doesn't know yet made
// the eligibility check read the wrong container and dead-end the walk. No
// verdict means the recovery ghost offers at the cursor and the human decides
// (invariant 2), exactly like the no-walkable-node case.
export function cleanWalkRegion(tail: string, spec: LanguageSpec = RUST): string | undefined {
  const root = parserFor(spec).parse(tail).rootNode as unknown as SyntaxNode;
  const start = findWalkStart(root, spec);
  // Scope the dirty-parse check to the WALKED NODE's subtree, not the whole
  // tail: the tail runs to end-of-file, and one unparseable line anywhere
  // below the region revoked every verdict — recovery then offered each node
  // at the cursor and a tabbing human nested siblings doll-style. Garbage that
  // error recovery absorbs INTO the region still fails (subtree hasError).
  if (!start || start.hasError) return undefined;
  return tail.slice(0, start.endIndex);
}

// The function named `name`, in pre-order — where a modify/delete step's symbol
// already lives, so the guide runner can park the cursor on it. `src` is the
// buffer the node indexes into (to read the name field).
export function findFunctionByName(node: SyntaxNode, src: string, name: string, spec: LanguageSpec = RUST): SyntaxNode | null {
  if (spec.functionTypes.has(node.type) && spec.nameOf(node, src) === name) return node;
  for (const c of namedChildren(node)) {
    const f = findFunctionByName(c, src, name, spec);
    if (f) return f;
  }
  return null;
}

// Any named item the replay can address by name — not just functions. The diff
// engine is kind-agnostic (it tree-diffs whatever bytes it's handed); which node
// types are addressable and how their name reads is the language's call
// (language.ts). First match wins — a name reused across items resolves to the
// first (the guide should disambiguate). When the item sits inside a wrapper the
// language says belongs to it (export_statement, decorated_definition), the
// wrapper is returned so those bytes travel with the symbol.
export function findItemByName(node: SyntaxNode, src: string, name: string, spec: LanguageSpec = RUST): SyntaxNode | null {
  const hit = findItem(node, src, name, spec, null);
  return hit;
}

function findItem(
  node: SyntaxNode,
  src: string,
  name: string,
  spec: LanguageSpec,
  liftableAncestor: SyntaxNode | null,
): SyntaxNode | null {
  if (spec.namedItemTypes.has(node.type) && spec.nameOf(node, src) === name) {
    return liftableAncestor ?? node;
  }
  for (const c of namedChildren(node)) {
    // A lift wrapper only counts when it directly wraps the item (possibly via
    // nested wrappers), so unrelated ancestors never inflate the symbol.
    const lift = spec.liftParents.has(node.type) ? (liftableAncestor ?? node) : null;
    const f = findItem(c, src, name, spec, lift);
    if (f) return f;
  }
  return null;
}

// Whether the create walk can rebuild `src` byte-exact — proven by simulation,
// not by enumerating hazards: replay the steps and demand byte equality.
// Anything the walk would silently lose fails here: a node kind the walk has no
// shape for, trailing bytes outside the walked node, grammar quirks that put
// bytes where no named child claims them. A non-walkable source must ride the
// whole-symbol block-swap surface instead: same ground truth, one Tab.
export function walkableSource(src: string, spec: LanguageSpec = RUST): boolean {
  if (spec.functionTypes.size === 0) return false;
  let steps: Step[];
  try {
    steps = computeSteps(src, spec);
  } catch {
    return false; // no walkable node in source
  }
  let buf = "";
  let cur = 0;
  for (const s of steps) {
    buf = buf.slice(0, cur) + s.insert + buf.slice(cur);
    cur = s.cursorOffset;
  }
  return buf === src;
}

// Extend an item's start back over the doc comments and attributes attached above
// it. Grammars model outer doc comments and attributes as PRECEDING SIBLINGS, not
// children, so the item node excludes them — and a change confined to the comment
// (a rewrite of the fn's doc) would be invisible to the diff. Scan the source
// upward line by line from the item, absorbing contiguous trivia lines (the
// language says what counts), stopping at a blank line (detached) or any code
// line. Line-based so it needs no sibling API on the minimal SyntaxNode view.
export function leadingTriviaStart(src: string, itemStart: number, spec: LanguageSpec = RUST): number {
  const isTrivia = (line: string): boolean => {
    const t = line.trim();
    if (t === "") return false; // blank line → the comment block is detached
    return spec.isTriviaLine(t);
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
 * Compute the disclosure steps for the first walkable node in `src` — a bare
 * function, or an item container (class/impl/mod) whose members disclose one by
 * one, methods descending like any function.
 * Offsets are relative to the start of `src` (region offset 0).
 *
 * Layout is SOURCE-DERIVED: every byte between siblings, after a `{`, and
 * before a `}` is a slice of `src`, never synthesized — so blank lines between
 * members survive and the build is byte-exact at any depth by construction.
 * The first line carries no pad; the cursor is already at its column.
 */
export function computeSteps(src: string, spec: LanguageSpec = RUST): Step[] {
  const root = parserFor(spec).parse(src).rootNode as unknown as SyntaxNode;
  const start = findWalkStart(root, spec);
  if (!start) throw new Error("no walkable node in source");

  // Leading trivia (doc comments, attributes) rides the first step as a block —
  // emitted verbatim ahead of the shell, so a documented method still walks and
  // a created #[test] still runs. (bareText excludes the prefix: divergence
  // recovery re-appends the shell only.)
  const prefix = src.slice(0, start.startIndex);

  // Raw emissions in pre-order: text and the cursor it is inserted at, in the
  // coordinates of the buffer as it exists at that moment. Built by splicing a
  // real string so positions are exact. `col` is the node's own source column:
  // bareText continuation lines are dedented by it, because recovery consumers
  // (buildRecoveryGhost, appendEdit) re-indent from the cursor and a
  // source-absolute column underneath doubles the indent.
  const raw: { insert: string; insertPos: number; kind: Step["kind"]; parentKey: string; bareText: string; col: number }[] = [];
  let buffer = "";
  const splice = (pos: number, text: string) => {
    buffer = buffer.slice(0, pos) + text + buffer.slice(pos);
  };
  const colOf = (i: number): number => {
    let c = 0;
    for (let k = i - 1; k >= 0 && src[k] !== "\n"; k--) c++;
    return c;
  };
  // Strip up to `col` leading spaces from every line but the first — the
  // inverse of the re-indent the recovery path applies.
  const dedent = (text: string, col: number): string => {
    if (col === 0) return text;
    const strip = new RegExp(`^ {0,${col}}`);
    return text
      .split("\n")
      .map((l, i) => (i === 0 ? l : l.replace(strip, "")))
      .join("\n");
  };

  // Emit `node`'s skeleton beginning at `pos`; `lead` is the source bytes
  // between the previous sibling and this node, folded into the step so the
  // provider inserts it at the previous sibling's end. `parentKey` is the
  // header of the container this node lands in (for re-anchored recovery).
  // Returns the position immediately after this node's full skeleton.
  function emit(node: SyntaxNode, pos: number, lead: string, parentKey: string): number {
    const d = descendable(node, spec);
    if (!d) {
      const bareText = src.slice(node.startIndex, node.endIndex);
      const text = lead + bareText;
      splice(pos, text);
      raw.push({ insert: text, insertPos: pos, kind: "leaf", parentKey, bareText, col: colOf(node.startIndex) });
      return pos + text.length;
    }
    const header = src.slice(d.node.startIndex, d.block.startIndex + 1); // ends with `{`
    // The recovery shell (no baked lead/blank line): `header {\n}`.
    const bareText = header + "\n}";
    const kids = namedChildren(d.block);

    if (kids.length === 0) {
      // Empty body: the shell IS the node — emit its interior verbatim.
      const body = lead + header + src.slice(d.block.startIndex + 1, d.block.endIndex);
      splice(pos, body);
      raw.push({ insert: body, insertPos: pos, kind: "container", parentKey, bareText, col: colOf(d.node.startIndex) });
      return pos + body.length;
    }

    // Shape first: header, the source bytes up to where the first child will
    // sit, and the source bytes that close the block after the last child.
    const preFirst = src.slice(d.block.startIndex + 1, kids[0].startIndex);
    const close = src.slice(kids[kids.length - 1].endIndex, d.block.endIndex);
    const body = lead + header + preFirst + close;
    splice(pos, body);
    raw.push({ insert: body, insertPos: pos, kind: "container", parentKey, bareText, col: colOf(d.node.startIndex) });

    // This container's own key, for its children to re-anchor against.
    const childKey = src.slice(d.node.startIndex, d.block.startIndex).trim();
    let cursor = emit(kids[0], pos + lead.length + header.length + preFirst.length, "", childKey);
    for (let i = 1; i < kids.length; i++) {
      cursor = emit(kids[i], cursor, src.slice(kids[i - 1].endIndex, kids[i].startIndex), childKey);
    }
    return cursor + close.length;
  }

  emit(start, 0, prefix, "ROOT");

  // cursorOffset of step i = insertPos of step i+1 (the next insertion point);
  // last step's cursor lands at the end of its own insert. The first step's
  // recovery bareText carries the prefix: doc comments and attributes are the
  // symbol's bytes, and a recovery-landed first step must not drop them (the
  // prefix shares the walk-start node's column, so one dedent covers both).
  return raw.map((r, i) => ({
    insert: r.insert,
    kind: r.kind,
    parentKey: r.parentKey,
    bareText: dedent(i === 0 ? prefix + r.bareText : r.bareText, r.col),
    insertOffset: r.insertPos,
    cursorOffset: i + 1 < raw.length ? raw[i + 1].insertPos : r.insertPos + r.insert.length,
  }));
}
