import * as vscode from "vscode";
import { DisclosureController } from "./disclosure/controller";
import { DiffReplayController } from "./disclosure/diffReplayController";

/**
 * The surface the replay renders through. VS Code's inline-completion ghost is
 * the only native way to put unlanded text in front of the caret and take a Tab
 * for it, so the two replay engines borrow it: the insert walk's next AST step
 * and diff-replay's next hunk both arrive here as a ready-made item.
 *
 * Model-free by construction. This provider computes nothing — it asks whichever
 * engine owns the document for the item it already holds, and returns nothing
 * when no replay is active. A document with no replay running gets no ghost.
 */
export class ReplayGhostProvider implements vscode.InlineCompletionItemProvider {
  constructor(
    private readonly disclosure: DisclosureController,
    private readonly diffReplay: DiffReplayController,
  ) {}

  provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.InlineCompletionItem[] | undefined {
    if (this.disclosure.isActive(document)) {
      const item = this.disclosure.currentItem(document, position);
      return item ? [item] : undefined;
    }

    if (this.diffReplay.isActive(document)) {
      const item = this.diffReplay.currentItem(document, position);
      return item ? [item] : undefined;
    }

    return undefined;
  }
}
