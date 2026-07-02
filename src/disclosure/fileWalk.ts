// File walk segmentation — how a create-file step discloses instead of dropping.
//
// A brand-new file has no anchor for the symbol walk, but it still has structure:
// top-level items, blank-line-separated. This module cuts the sandbox file into
// ordered segments the runner lands one gesture at a time — an import group, a
// detached comment block, a struct, a function. Byte-exact by construction: the
// segments concatenate back to the whole file, so ground truth holds (invariant
// 1) with no normalization anywhere.
//
// Pure and vscode-free: the runner owns cursors and ghosts; this owns only the
// cut. Which surface a segment rides (descend-and-fill walk vs whole-block
// ghost) is the runner's call via walkableSource, per segment.

import { LanguageSpec } from "./language";
import { SyntaxNode, namedChildren } from "./walk";
import { parseRoot } from "./diff";

export interface FileSegment {
  /** Whitespace-only bytes between the previous segment and this one. The runner
   *  types these as real buffer bytes — a whitespace-leading ghost can't be
   *  Tab-accepted (see splitLeadingPad). */
  sep: string;
  /** The segment's content: one blank-line-separated group of top-level items,
   *  attached trivia included. One gesture — a walk or a block ghost. */
  body: string;
}

// Whether the boundary at `offset` sits on a blank line: the whitespace run
// spanning it carries two or more newlines. Grammars disagree on who owns a
// trailing blank line (markdown sections swallow theirs), so the test looks at
// the bytes around the boundary, not at node spans.
function blankLineAt(text: string, offset: number): boolean {
  let a = offset;
  while (a > 0 && /\s/.test(text[a - 1])) a--;
  let b = offset;
  while (b < text.length && /\s/.test(text[b])) b++;
  return (text.slice(a, b).match(/\n/g) ?? []).length >= 2;
}

function toSegment(text: string, start: number, end: number): FileSegment {
  const raw = text.slice(start, end);
  const sep = /^\s*/.exec(raw)![0];
  return { sep, body: raw.slice(sep.length) };
}

/**
 * Cut a whole file into disclosure segments: one per blank-line-separated group
 * of top-level items. Items on adjacent lines (an import block, a comment
 * directly above its function) ride together; a blank line starts a new
 * segment. The last segment carries the trailing newline. Concatenating
 * `sep + body` across segments reproduces `text` byte-exact.
 *
 * No spec (unsupported language) or nothing parseable at top level → one
 * segment, the whole file: still a single human gesture, never a silent drop.
 * An empty file has nothing to disclose → no segments.
 */
export function planFileWalk(text: string, spec: LanguageSpec | undefined): FileSegment[] {
  if (text.length === 0) return [];
  if (!spec) return [toSegment(text, 0, text.length)];

  const root = parseRoot(text, spec) as unknown as SyntaxNode;
  let items = namedChildren(root);
  // A lone item spanning the file whose children are themselves named items is
  // a wrapper, not a unit: a markdown H1 section holds the H2 sections, and one
  // gesture for the whole document teaches nothing. Descend and cut at the
  // children. A lone function stays whole — its children are its own body, and
  // cutting inside a body is not a file walk.
  while (items.length === 1) {
    const kids = namedChildren(items[0]);
    if (!kids.some((k) => spec.namedItemTypes.has(k.type))) break;
    items = kids;
  }
  if (items.length === 0) return [toSegment(text, 0, text.length)];

  // Cut points: each item's start where a blank line precedes it. Byte ranges
  // between cut points cover the file with no gaps, so grammar quirks (bytes no
  // named child claims) stay inside a segment instead of vanishing.
  const cuts: number[] = [];
  for (let i = 1; i < items.length; i++) {
    if (blankLineAt(text, items[i - 1].endIndex)) cuts.push(items[i - 1].endIndex);
  }

  const segments: FileSegment[] = [];
  let start = 0;
  for (const cut of cuts) {
    segments.push(toSegment(text, start, cut));
    start = cut;
  }
  segments.push(toSegment(text, start, text.length));
  return segments;
}

/**
 * Where a partially-built target file resumes in the walk: the number of whole
 * segments already landed. The walk only ever appends full segments, so a prior
 * session's partial build is a byte-prefix ending exactly on a segment boundary.
 * Anything else (a mid-walk cancel, an unrelated file at the same path) returns
 * undefined — a genuine conflict the human resolves, never a guess.
 */
export function resumeIndex(segments: FileSegment[], existing: string): number | undefined {
  let built = "";
  if (existing === built) return 0;
  for (let i = 0; i < segments.length; i++) {
    built += segments[i].sep + segments[i].body;
    if (existing === built) return i + 1;
  }
  return undefined;
}
