import * as vscode from "vscode";

// Keep the parked cursor on screen as the walk steps a symbol. Mirrors the guide
// runner: InCenterIfOutsideViewport only scrolls when the anchor has left the
// viewport, so an already-visible step never jolts the editor.
export function revealCursor(editor: vscode.TextEditor, pos: vscode.Position): void {
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
