// Weave replay notes into the FIM prompt — pure, vscode-free.
//
// A replay note is a comment-thread bubble: anchored UI, never document bytes.
// FIM prompts are built from document bytes, so without this the model cannot
// see what the human just asked for ("filter out anything over 100 dollars").
// The weave inserts each note as a synthetic comment line above its anchor —
// into the PROMPT only; the buffer is untouched and the suggestion is still
// the human's to Tab.

export interface WovenNote {
  /** 0-based re-anchored line the note points at. */
  line0: number;
  text: string;
}

/**
 * Insert each note as a comment line above its anchor line within `prefix`
 * (the document text up to the cursor). Notes anchored past the prefix (below
 * the cursor) are dropped — they cannot steer a completion at this cursor.
 * The synthetic line copies the anchor line's indentation (nearest non-blank
 * line above when the anchor is blank), so the model reads a plausible file.
 */
export function weaveNotes(prefix: string, notes: WovenNote[], open: string, close?: string): string {
  if (notes.length === 0) return prefix;
  const lines = prefix.split("\n");
  // A note whose text already sits in the buffer (the human typed the comment
  // themselves, or a replay landed it) must not weave again: a duplicated
  // instruction teaches the model "comment, code, comment, code" and it echoes
  // the comment instead of following it — observed live.
  const inRange = notes.filter((n) => n.line0 >= 0 && n.line0 < lines.length && !prefix.includes(n.text));
  // Descending order keeps earlier indices valid as lines are spliced in.
  for (const n of [...inRange].sort((a, b) => b.line0 - a.line0)) {
    let at = n.line0;
    let indent = /^[ \t]*/.exec(lines[at])![0];
    if (lines[at].trim() === "") {
      for (let k = at - 1; k >= 0; k--) {
        if (lines[k].trim() !== "") {
          indent = /^[ \t]*/.exec(lines[k])![0];
          break;
        }
      }
    }
    lines.splice(at, 0, `${indent}${open} ${n.text}${close ? ` ${close}` : ""}`);
  }
  return lines.join("\n");
}

/** The line-comment token for a VS Code languageId — `//` unless the language
 *  says otherwise. Wrong-but-plausible beats nothing: the model reads it as a
 *  comment either way. */
export function noteToken(languageId: string): { open: string; close?: string } {
  switch (languageId) {
    case "python":
    case "shellscript":
    case "yaml":
    case "toml":
    case "r":
      return { open: "#" };
    case "css":
      return { open: "/*", close: "*/" };
    case "html":
    case "markdown":
      return { open: "<!--", close: "-->" };
    default:
      return { open: "//" };
  }
}
