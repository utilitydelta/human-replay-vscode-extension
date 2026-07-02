// Pure buffer-formatting helper for the guide runner's create-at-end-of-file path.
//
// A created symbol should land on a fresh line separated from prior content by one
// empty line — never glued under the previous `}`. This computes the newlines to
// append so the cursor, placed at the new end, sits on a blank line with one blank
// line of separation above it. vscode-free so it can be proven headless.

/** Newlines to append to `text` so end-of-file is a blank, separated line. */
export function separatorToInsert(text: string): string {
  if (text.replace(/\s/g, "").length === 0) return ""; // empty/whitespace file: land as-is
  const trailingNewlines = text.match(/\n*$/)?.[0].length ?? 0;
  return "\n".repeat(Math.max(0, 2 - trailingNewlines));
}
