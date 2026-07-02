// The pure core of the divergence-recovery ghost: given the cursor's line text, the
// cursor column, and the next planned step, build the node to INSERT at the cursor
// (Range(pos, pos)) and the caret offset within it to land on after accepting.
//
// Cursor-anchored, not recomputed: the node is indented to the cursor column, so it
// renders as an ordinary multi-line insert ghost (the happy path proves those render)
// and never yanks the cursor. On a blank line the node lands there directly; at the
// end of code it gets a leading newline + matching indent to open the next line. A
// container opens a blank indented inner line and the caret descends onto it (the
// happy-path descend); a leaf lands after its text.

const INDENT = 4;
const sp = (n: number) => " ".repeat(n);

export interface GhostStep {
  kind: "container" | "leaf";
  /** A container's `header {\n}` shell, or a leaf's source text. */
  bareText: string;
}

export function buildRecoveryGhost(
  lineText: string,
  character: number,
  step: GhostStep,
): { text: string; caret: number } {
  const before = lineText.slice(0, character);
  const onBlank = before.trim().length === 0;
  const baseIndent = onBlank ? before.length : lineText.length - lineText.trimStart().length;

  let body: string;
  let caret: number;
  if (step.kind === "container") {
    // The shell is `<header incl. "{">\n}`. The header may span lines — C#
    // puts the opening brace on its own line — so cut at the closing suffix,
    // never at the first newline (that dropped C#'s `{` entirely), and indent
    // the header's continuation lines like any other multi-line insert.
    const raw = step.bareText.endsWith("\n}") ? step.bareText.slice(0, -2) : step.bareText;
    const header = raw
      .split("\n")
      .map((l, i) => (i === 0 ? l : sp(baseIndent) + l))
      .join("\n");
    const inner = baseIndent + INDENT;
    body = header + "\n" + sp(inner) + "\n" + sp(baseIndent) + "}";
    caret = header.length + 1 + inner; // past the shell's `{\n` + the inner indent
  } else {
    const lines = step.bareText.split("\n");
    body = lines.map((l, i) => (i === 0 ? l : sp(baseIndent) + l)).join("\n");
    caret = body.length;
  }

  const lead = onBlank ? "" : "\n" + sp(baseIndent);
  return { text: lead + body, caret: lead.length + caret };
}
