import * as vscode from "vscode";
import { PendingComment } from "./promptgen";
import { CommentAnchor, anchorAt, resolveAnchorLine } from "./commentAnchor";

// The surfacing layer's capture half: speech-bubble comments the human drops while
// reading the replay. A note collates on the session until the human takes one of
// three exits — keep them (next block), clear them, or pull them into a prompt for
// the sandbox agent. The decision is always the human's (invariant 2); this layer
// only holds the notes.
//
// Each note is pinned to a *semantic* anchor at capture (the smallest node spanning
// the line), not a bare row+col, so when the replay shifts the buffer the note
// rides the move — its line is re-resolved against the live tree before it feeds a
// prompt. See commentAnchor.ts. Falls back to the captured line when unanchored.
//
// Built on VS Code's native comment threads (the PR-review speech bubble): hover a
// line, click the gutter +, type, submit.
interface Collated {
  /** 0-based line at capture — the fallback if re-anchoring fails. */
  line0: number;
  text: string;
  thread: vscode.CommentThread;
  uri: vscode.Uri;
  anchor: CommentAnchor | null;
}

export class CommentLayer {
  private readonly controller: vscode.CommentController;
  private collated: Collated[] = [];

  constructor(private readonly output: vscode.OutputChannel) {
    this.controller = vscode.comments.createCommentController(
      "humanReplay.comments",
      "Replay Notes",
    );
    // Allow a comment on any line of the file under replay.
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)],
    };
  }

  // Wired to the thread's submit button (comments/commentThread/context).
  add(reply: vscode.CommentReply): void {
    const thread = reply.thread;
    const comment: vscode.Comment = {
      body: new vscode.MarkdownString(reply.text),
      mode: vscode.CommentMode.Preview,
      author: { name: "You" },
    };
    thread.comments = [...thread.comments, comment];
    thread.label = "Replay note";
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const line0 = thread.range ? thread.range.start.line : 0;
    const doc = this.docFor(thread.uri);
    const anchor = doc ? anchorAt(doc.getText(), line0) : null;
    this.collated.push({ line0, text: reply.text, thread, uri: thread.uri, anchor });
    this.output.appendLine(
      `[comments] +line ${line0 + 1}${anchor ? " (anchored)" : ""}: ${reply.text}  (${this.collated.length} collated)`,
    );
  }

  private docFor(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  }

  // Current 1-based line of a note, re-anchored against the live buffer so a note
  // dropped before the replay shifted the code still points at the right place.
  private currentLine(c: Collated): number {
    const doc = this.docFor(c.uri);
    if (doc && c.anchor) return resolveAnchorLine(doc.getText(), c.anchor) + 1;
    return c.line0 + 1;
  }

  // Move each note's bubble to its re-anchored line — keeps the gutter marker on
  // the code it was about after the replay shifted the buffer.
  reanchor(): void {
    for (const c of this.collated) {
      const line = this.currentLine(c) - 1;
      if (c.thread.range && c.thread.range.start.line !== line) {
        c.thread.range = new vscode.Range(line, 0, line, 0);
      }
    }
  }

  // Exit: drop every note.
  clear(): void {
    for (const c of this.collated) c.thread.dispose();
    const n = this.collated.length;
    this.collated = [];
    this.output.appendLine(`[comments] cleared (${n})`);
  }

  // Exit: keep the notes and move on (the next replay block). For this slice
  // there is no next symbol yet, so this just keeps them and logs.
  nextBlock(): void {
    this.output.appendLine(`[comments] kept ${this.collated.length} for the next block`);
  }

  get comments(): PendingComment[] {
    return this.collated.map((c) => ({ line: this.currentLine(c), text: c.text }));
  }

  get count(): number {
    return this.collated.length;
  }

  dispose(): void {
    this.controller.dispose();
  }
}
