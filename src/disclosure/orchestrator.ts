import * as vscode from "vscode";
import { classifyReplay } from "./strategy";
import { walkableSource } from "./walk";
import { DisclosureController } from "./controller";
import { DiffReplayController } from "./diffReplayController";
import { revealCursor } from "./reveal";
import { Retrospective } from "../retrospective/retrospective";
import { LanguageSpec, RUST } from "./language";

// Routes a changed symbol to the right replay engine. The classifier reads the
// AST (survival ratio + control-flow skeleton change) and decides: a light touch
// goes to surgical diff-replay (dramatic), a wholesale change goes to clear-and-
// rewrite — strike the old symbol whole, Tab to clear it, then descend-and-fill
// the new one from scratch so the human reads the new shape, not a pile of hunks.
// Model-free; the decision is the AST's, not a judgment call.

const REWRITE_CONTEXT = "humanReplay.rewriteStrikeActive";

export class ReplayOrchestrator {
  private readonly strike: vscode.TextEditorDecorationType;
  private pending: { editor: vscode.TextEditor; range: vscode.Range; newSrc: string; retro?: Retrospective; spec: LanguageSpec } | undefined;
  private onDeleteComplete: ((retro?: Retrospective) => void) | undefined;

  /** A delete's whole gesture is the strike-and-clear: no walk follows, so no
   *  engine completion event fires. This hook is how the clear itself reports
   *  done (the guide runner advances its counter on it). */
  setDeleteCompletionHandler(handler: (retro?: Retrospective) => void): void {
    this.onDeleteComplete = handler;
  }

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly disclosure: DisclosureController,
    private readonly diffReplay: DiffReplayController,
  ) {
    this.strike = vscode.window.createTextEditorDecorationType({
      textDecoration: "line-through",
      backgroundColor: "rgba(248, 81, 73, 0.18)",
    });
  }

  /** A Patch step's whole-file, line-grain replay: hunks from a line diff of
   *  live target bytes vs sandbox bytes, served on the decoration surface (Tab
   *  per hunk). No classifier, no parse — the file may have no grammar. The
   *  anchor is file start; the caller parks the cursor there. */
  async startPatch(editor: vscode.TextEditor, oldText: string, newText: string, retro?: Retrospective): Promise<void> {
    await this.diffReplay.start(editor, oldText, newText, retro, true, true, RUST, true);
  }

  async start(editor: vscode.TextEditor, oldSrc: string, newSrc: string, retro?: Retrospective, inPlace = false, spec: LanguageSpec = RUST): Promise<void> {
    const plan = classifyReplay(oldSrc, newSrc, spec);
    this.output.appendLine(
      `[replay] strategy=${plan.strategy} survival=${Math.round(plan.survival * 100)}% ` +
        `skeletonChange=${Math.round(plan.skeletonChange * 100)}% hunks=${plan.hunks}`,
    );
    // A rewrite normally strikes the old symbol whole and descend-and-fills the
    // new one — a walk only brace languages support, and only for a bare function
    // (the walk emits from the fn node; doc comments, attributes, and non-fn items
    // would be silently dropped). Elsewhere the same gesture rides diff-replay's
    // block surface: strike, preview, Tab applies the whole block. Same ground
    // truth, no walk. An empty newSrc is a delete — the strike IS the gesture.
    const noWalk =
      spec.functionTypes.size === 0 ||
      (newSrc.trim() !== "" && !walkableSource(newSrc, spec, editor.selection.active.character));
    if (plan.strategy === "surgical" || noWalk) {
      if (plan.strategy !== "surgical") this.output.appendLine("[replay] rewrite via block swap (not walkable: trivia, non-fn item, or no walk for this language)");
      await this.diffReplay.start(editor, oldSrc, newSrc, retro, true, inPlace, spec);
      return;
    }
    await this.startRewrite(editor, oldSrc, newSrc, retro, inPlace, spec);
  }

  // Strike the old symbol whole (red) and arm the Tab-to-clear gesture. Demo path
  // seeds the symbol first; the real replay (inPlace) strikes the one already in the
  // workspace at the cursor (oldSrc was resolved from it).
  private async startRewrite(editor: vscode.TextEditor, oldSrc: string, newSrc: string, retro?: Retrospective, inPlace = false, spec: LanguageSpec = RUST): Promise<void> {
    const at = editor.selection.active;
    if (!inPlace) await editor.edit((b) => b.insert(at, oldSrc));
    const range = new vscode.Range(at, editor.document.positionAt(editor.document.offsetAt(at) + oldSrc.length));
    editor.setDecorations(this.strike, [
      {
        range,
        renderOptions: { after: { contentText: "  ⟶  rewritten — Tab to clear and re-disclose", color: "#3fb950", fontStyle: "italic" } },
      },
    ]);
    this.pending = { editor, range, newSrc, retro, spec };
    editor.selection = new vscode.Selection(at, at);
    void vscode.commands.executeCommand("setContext", REWRITE_CONTEXT, true);
    this.output.appendLine("[replay] rewrite: struck old symbol, awaiting clear");
  }

  // Tab on a struck rewrite: clear the old symbol, then descend-and-fill the new.
  async acceptRewriteClear(): Promise<void> {
    const p = this.pending;
    if (!p) return;
    // Claim before awaiting: a second Tab arriving while the delete is in flight
    // must find nothing pending, or the range gets deleted twice — the second
    // pass eating whatever bytes slid into it.
    this.pending = undefined;
    await p.editor.edit((b) => b.delete(p.range));
    p.editor.setDecorations(this.strike, []);
    void vscode.commands.executeCommand("setContext", REWRITE_CONTEXT, false);
    p.editor.selection = new vscode.Selection(p.range.start, p.range.start);
    revealCursor(p.editor, p.range.start);
    // A delete step has no new symbol to disclose — clearing the struck old one is
    // the whole gesture. Only descend-and-fill when there is something to fill.
    if (p.newSrc.trim() === "") {
      this.output.appendLine("[replay] delete: cleared old symbol, nothing to disclose");
      this.onDeleteComplete?.(p.retro);
      return;
    }
    this.output.appendLine("[replay] rewrite: cleared old symbol, disclosing new");
    await this.disclosure.start(p.editor, p.newSrc, p.retro, p.spec);
  }

  cancel(): void {
    if (!this.pending) return;
    this.pending.editor.setDecorations(this.strike, []);
    void vscode.commands.executeCommand("setContext", REWRITE_CONTEXT, false);
    this.pending = undefined;
  }

  /** Tear down whichever engine this orchestrator put in flight — the rewrite
   *  strike and the diff-replay session both. The skip gesture needs one call
   *  that leaves no decoration behind. */
  cancelAll(): void {
    this.cancel();
    this.diffReplay.cancel();
  }
}
