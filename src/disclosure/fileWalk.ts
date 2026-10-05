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
import { SyntaxNode, namedChildren, walkableSource } from "./walk";
import { splitLeadingPad } from "./insertion";
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
 * Split a segment body's trailing whitespace (the file's final newline) off its
 * content. The walk rebuilds a node's bytes exactly and nothing more, so the
 * tail must be typed by the runner — inserted at end-of-file BEFORE the walk
 * starts, with the cursor parked ahead of it. Bytes land identically; without
 * the split every last segment fails the walkability simulation and falls back
 * to a block ghost.
 */
export function splitTrailing(body: string): { content: string; tail: string } {
  const tail = /\s*$/.exec(body)![0];
  return { content: body.slice(0, body.length - tail.length), tail };
}

/** Where a create-file walk picks up: `at` whole segments landed, and the
 *  first `leadTyped` bytes of the next segment's separator already at the end
 *  of the target, so the runner types only the rest. */
export interface WalkResume {
  at: number;
  leadTyped: number;
}

// The target-line index each of `want`'s lines matched, in order, as whole
// lines: an order-preserving subsequence, earliest match first. Undefined when
// some line of `want` has no match left.
function matchLines(want: readonly string[], have: readonly string[]): number[] | undefined {
  const at: number[] = [];
  let j = 0;
  for (const line of want) {
    while (j < have.length && have[j] !== line) j++;
    if (j === have.length) return undefined;
    at.push(j++);
  }
  return at;
}

const nonBlank = (lines: readonly string[]): string[] => lines.map((l) => l.trim()).filter((l) => l !== "");

/** Whether the lines below the landed prefix are safe to leave there while the
 *  next segment is appended after them.
 *
 *  Two ways they aren't. A line equal to one of the next segment's lines means
 *  the human typed part of it, or landed bytes moved below the frontier; the
 *  append would land them twice. And when the next segment rides the walk, a
 *  re-arm can leave the walk's partial build there (`fn big() {` with half a
 *  body), whose lines need not match any finished line. Comments are the one
 *  thing a walk never starts with, so below a walk's frontier only comments
 *  pass. Human CODE below the frontier refuses resume: it is indistinguishable
 *  from partial bytes (session-v4/limits.md). */
function belowFrontierSafe(nextBody: string, after: readonly string[], spec: LanguageSpec | undefined): boolean {
  const got = nonBlank(after);
  if (got.length === 0) return true;
  const want = new Set(nonBlank(nextBody.split("\n")));
  if (got.some((l) => want.has(l))) return false;
  if (!spec) return true; // no grammar, no walk: segments land whole
  const { content } = splitTrailing(splitLeadingPad(nextBody).rest);
  if (content === "" || !walkableSource(content, spec)) return true;
  const root = parseRoot(after.join("\n"), spec) as unknown as SyntaxNode;
  return !root.hasError && namedChildren(root).every((n) => n.type.includes("comment"));
}

/**
 * Where a partially built target resumes, tolerating whole lines the human
 * ADDED: a comment above landed code, a note between segments, their own
 * lines after the last one. The walk only ever appends sandbox segments at
 * end-of-file, so the human's lines stay where they typed them.
 *
 * Proof, not fuzz. The first `at` segments' lines must all be present, in
 * order, each as a whole target line; every other target line is the
 * human's. An altered sandbox line is not an addition: the walk resumes no
 * further than the bytes prove. Lines inside the landed prefix are always
 * the human's: the walk never writes there. Lines BELOW it must pass
 * belowFrontierSafe, or appending could land bytes twice: undefined, the
 * runner's conflict path. `spec` lets that check see whether the next
 * segment rides the walk. No landed segment at all in a
 * non-empty target is undefined too. A target that merely CONTAINS the
 * sandbox's lines is a separate question: landedWithAdditions, which the
 * runner asks first, says yes to it (session-v4/limits.md).
 */
export function resumeWalk(segments: FileSegment[], existing: string, spec?: LanguageSpec): WalkResume | undefined {
  if (existing === "") return { at: 0, leadTyped: 0 };
  const have = existing.split("\n");
  let built = "";
  const prefixes = segments.map((s) => (built += s.sep + s.body));
  for (let k = segments.length; k >= 1; k--) {
    const matched = matchLines(prefixes[k - 1].split("\n"), have);
    if (!matched) continue;
    if (k === segments.length) return { at: k, leadTyped: 0 };
    const last = matched[matched.length - 1];
    // A prefix ending in a newline splits to a final empty element, matched to
    // whatever blank line comes first, possibly one BELOW hand-typed next
    // bytes. The guard reads from the prefix's last real line instead.
    const lastReal = prefixes[k - 1].endsWith("\n") && matched.length >= 2 ? matched[matched.length - 2] : last;
    if (!belowFrontierSafe(segments[k].body, have.slice(lastReal + 1), spec)) return undefined;
    // The earliest-first match can claim a partial build's `}` for the
    // prefix when the human edited the real one (`} // end small`), pulling
    // the partial INSIDE the prefix, where lines are unrestricted
    // (review-session-v4 E). A partial build always opens with the next
    // segment's first line, verbatim: that line unmatched anywhere refuses.
    const opener = nonBlank(segments[k].body.split("\n"))[0];
    const claimed = new Set(matched);
    if (opener !== undefined && have.some((l, i) => !claimed.has(i) && l.trim() === opener)) return undefined;
    // Typed lead counts only bytes AFTER the landed prefix's last byte. A
    // body that ends in its own newline (every markdown section) must not
    // read that newline as separator, or the runner skips a blank line the
    // sandbox has.
    let end = 0;
    for (let i = 0; i < last; i++) end += have[i].length + 1;
    const tail = existing.slice(end + have[last].length);
    const sep = segments[k].sep;
    let leadTyped = Math.min(sep.length, tail.length);
    while (leadTyped > 0 && !tail.endsWith(sep.slice(0, leadTyped))) leadTyped--;
    return { at: k, leadTyped };
  }
  return undefined;
}

/** A whole-file create is landed when every sandbox line is in the target, in
 *  order, as a whole line: the sandbox bytes plus only lines the human added.
 *  Safe because a create's base is empty, so no extra line can be one the
 *  sandbox deleted. A modify has a base and stays byte-exact. */
export function landedWithAdditions(sandbox: string, target: string): boolean {
  if (sandbox === target) return true;
  if (sandbox === "") return false;
  return matchLines(sandbox.split("\n"), target.split("\n")) !== undefined;
}

/**
 * What the runner types at end-of-file before a segment's engine runs: the
 * separator, the first-line pad, and, for a walk, the body's trailing
 * whitespace (the file's final newline), which sits after the parked cursor.
 * `cursorBack` is how far before the new end the cursor parks.
 *
 * On a resume (`leadTyped` > 0) some of that may already be there. A re-arm
 * click before the walk's first accept leaves the whole `sep + pad + tail` in
 * the buffer, and resumeWalk only measures the separator: typing the tail
 * again landed a byte neither side asked for (review-session-v4 finding 1).
 * So when the full separator is typed, the pad and tail behind it count too.
 */
export function leadPlan(
  seg: { sep: string; pad: string; tail: string; walkable: boolean },
  existing: string,
  leadTyped: number,
): { type: string; cursorBack: number } {
  const tail = seg.walkable ? seg.tail : "";
  if (leadTyped > 0 && leadTyped === seg.sep.length) {
    if (tail !== "" && existing.endsWith(seg.sep + seg.pad + tail)) return { type: "", cursorBack: tail.length };
    if (existing.endsWith(seg.sep + seg.pad)) return { type: tail, cursorBack: tail.length };
  }
  return { type: seg.sep.slice(leadTyped) + seg.pad + tail, cursorBack: tail.length };
}
