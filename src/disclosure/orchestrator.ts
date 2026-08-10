import * as vscode from "vscode";
import { classifyReplay } from "./strategy";
import { walkableSource } from "./walk";
import { DisclosureController } from "./controller";
import { DiffReplayController } from "./diffReplayController";
import { revealCursor } from "./reveal";
import { Retrospective } from "../retrospective/retrospective";
import { LanguageSpec, RUST } from "./language";
import { reconcileRewritePad, splitLeadingPad } from "./insertion";

// Routes a changed symbol to the right replay engine. The classifier reads the
// AST (survival ratio + control-flow skeleton change) and decides: a light touch
// goes to surgical diff-replay (dramatic), a wholesale change goes to clear-and-
// rewrite — strike the old symbol whole, Tab to clear it, then descend-and-fill
// the new one from scratch so the human reads the new shape, not a pile of hunks.
// Model-free; the decision is the AST's, not a judgment call.

const REWRITE_CONTEXT = "humanReplay.rewriteStrikeActive";

export class ReplayOrchestrator {
  private readonly strike: vscode.TextEditorDecorationType;
  private pending: { editor: vscode.TextEditor; range: vscode.Range; oldSrc: string; newSrc: string; retro?: Retrospective; spec: LanguageSpec } | undefined;
  private onDeleteComplete: ((retro?: Retrospective) => void) | undefined;
  // The clear's undo bytes: armed by acceptRewriteClear, consumed by the walk's
  // end signal. A cancel/collision at ZERO accepted steps restores the struck
  // symbol (one byte-checked edit) so the step re-runs — the live 3.3 clear
  // left a hole with no way back. Partial acceptance withholds the restore:
  // stomping half-landed work would eat human input.
  // `expect` is the byte-check inside the replaced range; `expectAfter` checks
  // the rest of the clear line beyond it, so even the zero-width-range branch
  // has real bytes to verify — a human edit in the hole surfaces instead of
  // being stomped or prepended to.
  private restorable: { editor: vscode.TextEditor; range: vscode.Range; expect: string; expectAfter: string; replacement: string } | undefined;
  private restoreInFlight: Promise<void> | undefined;

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
    this.disclosure.setSessionEndHandler((o) => this.onWalkEnd(o));
  }

  private onWalkEnd(o: { reason: "complete" | "cancelled"; accepted: number }): void {
    const r = this.restorable;
    this.restorable = undefined;
    if (!r || o.reason === "complete") return;
    if (o.accepted > 0) {
      this.output.appendLine(`[replay] rewrite walk cancelled after ${o.accepted} step(s) — restore withheld (half-landed work is yours to keep or finish)`);
      return;
    }
    this.restoreInFlight = this.restore(r).finally(() => (this.restoreInFlight = undefined));
  }

  // One byte-checked edit: the exact post-clear bytes — inside the range and
  // on the rest of its line — must still be there, or the restore is withheld
  // and surfaces (a human edit in the hole is never stomped).
  private async restore(r: { editor: vscode.TextEditor; range: vscode.Range; expect: string; expectAfter: string; replacement: string }): Promise<void> {
    const doc = r.editor.document;
    const afterEnd = new vscode.Position(r.range.end.line, r.range.end.character + r.expectAfter.length);
    const live = doc.getText(r.range);
    const liveAfter = doc.getText(new vscode.Range(r.range.end, afterEnd));
    if (live !== r.expect || liveAfter !== r.expectAfter || doc.lineAt(r.range.end.line).text.length !== r.range.end.character + r.expectAfter.length) {
      this.output.appendLine("[replay] rewrite cancelled at zero steps but the cleared spot changed — restore withheld; re-run the step to see the delta");
      return;
    }
    const ok = await r.editor.edit((b) => b.replace(r.range, r.replacement));
    this.output.appendLine(
      ok
        ? `[replay] rewrite cancelled at zero steps — struck symbol restored (${r.replacement.length} bytes)`
        : "[replay] rewrite restore edit failed — buffer left as-is",
    );
  }

  /** Awaits any in-flight restore, so a re-run resolves its Before bytes from
   *  the restored buffer, not from the hole (the runner awaits this after its
   *  teardown cancels). */
  async settleRestore(): Promise<void> {
    await this.restoreInFlight;
  }

  /** A Patch step's whole-file, line-grain replay: hunks from a line diff of
   *  live target bytes vs sandbox bytes, served on the decoration surface (Tab
   *  per hunk). No classifier, no parse — the file may have no grammar. The
   *  anchor is file start; the caller parks the cursor there. */
  async startPatch(editor: vscode.TextEditor, oldText: string, newText: string, retro?: Retrospective): Promise<void> {
    this.restorable = undefined; // a new step begins — stale undo bytes are dead
    await this.diffReplay.start(editor, oldText, newText, retro, true, true, RUST, true);
  }

  async start(editor: vscode.TextEditor, oldSrc: string, newSrc: string, retro?: Retrospective, inPlace = false, spec: LanguageSpec = RUST): Promise<void> {
    // A new step begins — a previous clear's undo bytes are dead. Left armed,
    // a later unrelated walk's cancel would consume them and splice a stale
    // symbol at a stale position.
    this.restorable = undefined;
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
      (newSrc.trim() !== "" && !walkableSource(newSrc, spec));
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
    this.pending = { editor, range, oldSrc, newSrc, retro, spec };
    editor.selection = new vscode.Selection(at, at);
    void vscode.commands.executeCommand("setContext", REWRITE_CONTEXT, true);
    this.output.appendLine("[replay] rewrite: struck old symbol, awaiting clear");
  }

  // Tab on a struck rewrite: clear the old symbol, then descend-and-fill the new.
  // Returns false only when nothing is pending (a stale context) — the caller
  // falls through to a real indent so Tab is never a silent dead key.
  async acceptRewriteClear(): Promise<boolean> {
    const p = this.pending;
    if (!p) {
      this.output.appendLine("[replay] tab: rewrite context is stale (nothing pending) — falling through to indent");
      void vscode.commands.executeCommand("setContext", REWRITE_CONTEXT, false);
      return false;
    }
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
      return true;
    }
    this.output.appendLine("[replay] rewrite: cleared old symbol, disclosing new");
    // A doc-commented symbol extracts from its LINE START, so a nested one leads
    // with the line's indent — and a whitespace-leading ghost can't be
    // Tab-accepted (see splitLeadingPad): Tab indented instead, the caret left
    // the anchor, and the walk dead-ended. Reconcile the line's indent before
    // walking: which side carries the pad flips with where each symbol's trivia
    // starts (a bare old parks AFTER the buffer's indent; a doc-commented old
    // parks at column 0 and its indent died with the strike), so the buffer's
    // own whitespace prefix — not the caret column alone — decides what to type.
    const { pad: newPad, rest } = splitLeadingPad(p.newSrc);
    const { pad: oldPad } = splitLeadingPad(p.oldSrc);
    const doc = p.editor.document;
    const lineStart = new vscode.Position(p.range.start.line, 0);
    const prefix = doc.getText(new vscode.Range(lineStart, p.range.start));
    if (/^[ \t]*$/.test(prefix)) {
      const want = reconcileRewritePad(prefix, oldPad, newPad);
      if (want !== prefix) await p.editor.edit((b) => b.replace(new vscode.Range(lineStart, p.range.start), want));
      const at = new vscode.Position(lineStart.line, want.length);
      p.editor.selection = new vscode.Selection(at, at);
      // Undo bytes for a dead-ended walk: replacing the reconciled indent with
      // the pre-strike prefix + old symbol is byte-identical to pre-strike.
      this.restorable = {
        editor: p.editor,
        range: new vscode.Range(lineStart, at),
        expect: want,
        expectAfter: doc.lineAt(at.line).text.slice(at.character),
        replacement: prefix + p.oldSrc,
      };
    } else {
      this.restorable = {
        editor: p.editor,
        range: new vscode.Range(p.range.start, p.range.start),
        expect: "",
        expectAfter: doc.lineAt(p.range.start.line).text.slice(p.range.start.character),
        replacement: p.oldSrc,
      };
    }
    await this.disclosure.start(p.editor, rest, p.retro, p.spec);
    return true;
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
