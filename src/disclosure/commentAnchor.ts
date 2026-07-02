// Semantic anchoring for replay notes.
//
// A comment dropped at a bare row+col drifts the moment the human edits above it:
// the note still points at line 12 while the code it was about moved to line 15.
// The fix is the same trick the replay uses for its ops — pin the note to a
// structural anchor (a named-child-index path to the smallest node spanning it),
// then re-resolve that path against a re-parse of the live buffer. The note rides
// the shift. Model-free, Rust-scoped like the rest of the engine.
//
// Resolution degrades gracefully: a broken path (the node's structure diverged)
// falls back to finding the captured snippet, then to the captured line — a note
// never lands nowhere.

import { parseRoot } from "./diff";
import { SyntaxNode } from "./walk";

export interface CommentAnchor {
  /** Named-child-index path from root to the node the note is pinned to. */
  path: number[];
  /** The node's first line at capture — the fallback when the path breaks. */
  snippet: string;
  /** The line the note was dropped on at capture — the last-resort fallback. */
  line: number;
}

function lineOf(src: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

// Byte offset of the first non-whitespace character on `line` (0-based).
function offsetOfLine(src: string, line: number): number | null {
  const lines = src.split("\n");
  if (line < 0 || line >= lines.length) return null;
  let off = 0;
  for (let i = 0; i < line; i++) off += lines[i].length + 1;
  return off + (lines[line].match(/^\s*/)?.[0].length ?? 0);
}

// Descend to the smallest named node whose [start, end) contains `off`, recording
// the named-child-index path taken.
function locate(root: SyntaxNode, off: number): { node: SyntaxNode; path: number[] } {
  let node = root;
  const path: number[] = [];
  for (;;) {
    let descended = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c && c.startIndex <= off && off < c.endIndex) {
        node = c;
        path.push(i);
        descended = true;
        break;
      }
    }
    if (!descended) break;
  }
  return { node, path };
}

/** Pin a note dropped on `line` (0-based) to the structure of `src`. */
export function anchorAt(src: string, line: number): CommentAnchor | null {
  const off = offsetOfLine(src, line);
  if (off === null) return null;
  const { node, path } = locate(parseRoot(src), off);
  if (path.length === 0) return null; // landed on the root — nothing structural to pin to
  const text = src.slice(node.startIndex, node.endIndex);
  return { path, snippet: text.split("\n")[0], line };
}

/** Re-resolve a note's anchor against the live `src`, returning its current line. */
export function resolveAnchorLine(src: string, anchor: CommentAnchor): number {
  let node: SyntaxNode | null = parseRoot(src);
  for (const i of anchor.path) {
    node = node.namedChild(i);
    if (!node) {
      node = null;
      break;
    }
  }
  if (node) return lineOf(src, node.startIndex);
  // Path broke (structural divergence): find the captured snippet, then give up
  // to the captured line — a note never resolves to nowhere.
  const idx = anchor.snippet ? src.indexOf(anchor.snippet) : -1;
  return idx >= 0 ? lineOf(src, idx) : anchor.line;
}
