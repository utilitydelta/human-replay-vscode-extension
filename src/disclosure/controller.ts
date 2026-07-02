import * as vscode from "vscode";
import { computeSteps, findFunction } from "./walk";
import { DisclosureSession } from "./session";
import { appendEdit, innermostContainerKey } from "./anchoredInsert";
import { buildRecoveryGhost } from "./recoveryGhost";
import { parseRoot } from "./diff";
import { LanguageSpec, RUST } from "./language";
import { revealCursor } from "./reveal";
import { Retrospective } from "../retrospective/retrospective";

const DIVERGED_CONTEXT = "humanReplay.disclosureDiverged";
const ACTIVE_CONTEXT = "humanReplay.disclosureActive";
// The caret sits where the next planned node can land (its parent container).
// Gates the diverged Tab keybinding: outside the container Tab stays an indent,
// so the human's own mid-walk code never fights the walk for the key.
const RECOVERY_ELIGIBLE_CONTEXT = "humanReplay.recoveryEligible";
const SETTLE_MS = 450; // wait for typing to settle before re-offering the recovery ghost

// Drives the descend-and-fill walk over the native inline-completion surface.
// When a session is active the completion provider yields the current step's
// text as a ghost; accepting it repositions the cursor into the just-opened block
// (or back out to the parent's next sibling) and the next ghost appears. Model-
// free: never touches Ollama.
//
// Happy path: the ghost is gated on cursor position — it shows only when the
// cursor sits on the current step's baked insertion anchor. Wandering off hides
// it; landing back brings it back. That single rule drives the next ghost after an
// accept, restores one after wandering, and stops a stray trigger from inserting at
// the wrong place.
//
// Recovery (the human authors mid-walk): one hand-edit invalidates every baked
// offset, so the walk re-anchors to the CURSOR, not to a recomputed point. The next
// planned node is offered as an INSERT at the human's current cursor (Range(pos,pos),
// indented to the cursor column) — the same multi-line insert ghost the happy path
// renders, so it renders here too, and there's no cursor yank because it appears
// where the cursor already is. Type → pause (settle) → ghost reappears → Tab inserts
// → cursor descends (controlled) → next ghost. If a spot can't take an insert ghost,
// Tab (gated on no inline suggestion) falls back to continueWalk — the same node
// placed by parent-container append (anchoredInsert).
//
// The caret is the human's. Recovery NEVER moves it on a timer or a selection
// event — a settle or an arrow key must not teleport the cursor out of the code
// they are writing (feedback.md #4). While the caret sits outside the pending
// node's container the walk simply waits (a one-time status hint says where);
// eligibility is re-checked on every cursor rest, so returning to the container
// brings the ghost back by itself. The two sanctioned caret moves are explicit
// gestures: accepting a ghost (Tab), and re-running the step from the panel.
//
// Two rules keep recovery calm rather than flashing on every keystroke. (1) The
// ghost is suppressed until typing SETTLES: VS Code auto-queries the provider on each
// keystroke, so a `recoverySettled` latch — false on each edit, true only when the
// debounce fires — makes those auto-queries return nothing while you type. (2) The
// ghost is only offered at a clean FRONTIER (nothing but whitespace after the cursor
// on its line), so editing the middle of an already-placed line is free — no ghost
// fights the edit; it returns when the cursor next rests at a line end.
export class DisclosureController {
  private session: DisclosureSession | undefined;
  private onComplete?: (session: DisclosureSession) => void;
  private onCollision?: () => void;
  // Set at the end of an accept so the next trigger can report the re-trigger gap.
  private lastAcceptAt: number | undefined;
  // The text we last offered (baked ghost or recovery ghost) — lets noteChange tell
  // our own insert/accept from the human authoring their own code.
  private lastOffered: { offset: number; text: string } | undefined;
  // Once the human authors mid-walk, baked offsets are stale: the walk switches to
  // the cursor-anchored recovery ghost.
  private diverged = false;
  // The recovery ghost last served: where it inserts, its text, and the absolute
  // caret offset to land on after accepting (the controlled descend).
  private recoveryGhost: { offset: number; text: string; caret: number } | undefined;
  // Debounce: re-offer the recovery ghost only once typing settles, never mid-keystroke.
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  // False while the human is mid-keystroke, true once typing has settled (or after an
  // accept). currentItem returns nothing while false, so VS Code's per-keystroke auto
  // re-query of the provider doesn't flash a ghost on every character.
  private recoverySettled = false;
  private continuing = false; // Tab re-entrancy latch for the re-anchored continue
  private recoveryEligible = false; // mirror of the context key, for dedupe
  private hintedIneligible = false; // one hint per excursion out of the container

  constructor(private readonly output: vscode.OutputChannel) {}

  // Called once with the completed session when a walk reaches its last step —
  // the hook the retrospective gating hangs on (the step end is a thinking point).
  setCompletionHandler(handler: (session: DisclosureSession) => void): void {
    this.onComplete = handler;
  }

  // Fired when a re-anchored continue can't place the next node (its parent in the
  // tree is gone) — the panel marks the step blocked; the human decides.
  setCollisionHandler(handler: () => void): void {
    this.onCollision = handler;
  }

  private setDiverged(v: boolean): void {
    this.diverged = v;
    void vscode.commands.executeCommand("setContext", DIVERGED_CONTEXT, v);
    // Divergence starts at the human's own edit, so the caret is almost always
    // in the right container — start eligible and let the settle correct it.
    this.setRecoveryEligible(v);
    this.hintedIneligible = false;
  }

  private setRecoveryEligible(v: boolean): void {
    if (this.recoveryEligible === v) return;
    this.recoveryEligible = v;
    void vscode.commands.executeCommand("setContext", RECOVERY_ELIGIBLE_CONTEXT, v);
  }

  private setActive(v: boolean): void {
    void vscode.commands.executeCommand("setContext", ACTIVE_CONTEXT, v);
  }

  isActive(document: vscode.TextDocument): boolean {
    return (
      !!this.session &&
      this.session.uri.toString() === document.uri.toString() &&
      !this.session.done
    );
  }

  // Absolute offset where the current step inserts (baked path).
  private expectedOffset(): number | undefined {
    const step = this.session?.current();
    if (!this.session || !step) return undefined;
    return this.session.anchorOffset + step.insertOffset;
  }

  // The ghost for the current step. Baked path: only when the cursor is on its
  // anchor. Recovery path: an insert at the cursor.
  currentItem(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.InlineCompletionItem | undefined {
    if (this.diverged) return this.recoveryItem(document, position);

    const step = this.session?.current();
    const expected = this.expectedOffset();
    if (!step || expected === undefined) return undefined;
    if (document.offsetAt(position) !== expected) return undefined;

    this.lastOffered = { offset: expected, text: step.insert };
    const item = new vscode.InlineCompletionItem(
      step.insert,
      new vscode.Range(position, position),
    );
    item.command = {
      command: "humanReplay.disclosureAccepted",
      title: "Human Replay: next disclosure step",
    };
    return item;
  }

  // The recovery ghost: the next planned node, inserted at the human's current
  // cursor (Range(pos, pos)), indented to the cursor column. No recompute, no
  // reposition — so it renders (a multi-line insert ghost, like the happy path) and
  // never yanks the cursor. The caret-after-accept is stashed for the descend.
  private recoveryItem(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.InlineCompletionItem | undefined {
    const s = this.session;
    const step = s?.current();
    if (!s || !step) return undefined;
    if (document.uri.toString() !== s.uri.toString()) return undefined;
    if (!this.recoverySettled) return undefined; // still typing — don't flash on auto re-query
    const at = document.offsetAt(position);
    if (at < s.anchorOffset) return undefined; // cursor above the symbol — never insert there

    const lineText = document.lineAt(position.line).text;
    // Only at a clean frontier — nothing but whitespace after the cursor on its line.
    // Editing the middle of an already-placed line must stay free of the ghost.
    if (lineText.slice(position.character).trim().length !== 0) return undefined;

    // Climb-out guard: a cursor-insert is right only when the cursor sits in this node's
    // OWN parent container. When the next node belongs to an ancestor (the walk is moving
    // back out — e.g. the function's tail after a nested loop), the cursor is still inside
    // a child block. `offerRecovery` drops the caret to the parent's frontier before the
    // ghost is meant to show; this guard declines any stray query in the brief window
    // before that move, so the node never renders in the wrong block.
    const symbolText = this.extractSymbol(document);
    if (symbolText !== undefined && innermostContainerKey(symbolText, at - s.anchorOffset, s.spec) !== step.parentKey) {
      return undefined;
    }

    const built = buildRecoveryGhost(lineText, position.character, step);
    this.recoveryGhost = { offset: at, text: built.text, caret: at + built.caret };
    this.lastOffered = { offset: at, text: built.text };
    const item = new vscode.InlineCompletionItem(
      built.text,
      new vscode.Range(position, position),
    );
    item.command = {
      command: "humanReplay.disclosureAccepted",
      title: "Human Replay: next disclosure step",
    };
    return item;
  }

  async start(
    editor: vscode.TextEditor,
    source: string,
    retrospective?: Retrospective,
    spec: LanguageSpec = RUST,
  ): Promise<void> {
    // The cursor column is the symbol's base indent: 0 at end-of-file, the child
    // indent when the runner parked it inside a container (or a rewrite cleared a
    // nested method). Seeding the walk with it keeps the build byte-exact at depth.
    const steps = computeSteps(source, spec, editor.selection.active.character);
    const anchorOffset = editor.document.offsetAt(editor.selection.active);
    this.session = new DisclosureSession(
      editor.document.uri,
      anchorOffset,
      steps,
      source.length,
      retrospective,
      spec,
    );
    this.lastAcceptAt = undefined;
    this.lastOffered = undefined;
    this.recoveryGhost = undefined;
    this.recoverySettled = false;
    this.clearSettle();
    this.setDiverged(false);
    this.setActive(true);
    this.output.appendLine(`[disclosure] start: ${steps.length} steps`);
    // Cursor is already on step 0's anchor, so no selection change fires — trigger
    // the first ghost directly. Every later ghost rides onSelectionChanged.
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
  }

  cancel(): void {
    if (!this.session) return;
    this.output.appendLine(`[disclosure] cancelled at step ${this.session.index}`);
    this.end();
  }

  // Drop the session without firing the completion hook — for cancel and collision,
  // where the symbol is intentionally left partly built for the human to finish.
  private end(): void {
    this.clearSettle();
    this.session = undefined;
    this.lastOffered = undefined;
    this.recoveryGhost = undefined;
    this.recoverySettled = false;
    this.setDiverged(false);
    this.setActive(false);
  }

  // Natural completion: drop the session and fire the retrospective hook.
  private finish(session: DisclosureSession): void {
    this.output.appendLine(`[disclosure] complete (${session.steps.length} steps)`);
    this.clearSettle();
    this.session = undefined;
    this.lastOffered = undefined;
    this.recoveryGhost = undefined;
    this.recoverySettled = false;
    this.setDiverged(false);
    this.setActive(false);
    this.onComplete?.(session);
  }

  // Runs after the user accepts a step's ghost (VS Code has already inserted the
  // text). Baked path: reposition the cursor onto the next step's anchor. Recovery
  // path: land on the stashed caret (descend), then advance. The resulting cursor
  // move re-triggers the next ghost via onSelectionChanged.
  onAccepted(editor: vscode.TextEditor): void {
    const session = this.session;
    if (!session) return;

    if (this.diverged) {
      const g = this.recoveryGhost;
      if (g) {
        const caret = editor.document.positionAt(g.caret);
        editor.selection = new vscode.Selection(caret, caret);
        revealCursor(editor, caret);
      }
      this.recoveryGhost = undefined;
      this.recoverySettled = true; // the human accepted, not typed — show the next ghost at once
      session.advance();
      if (session.done) {
        this.finish(session);
        return;
      }
      this.output.appendLine(`[disclosure] recovery accept ${session.index}/${session.steps.length}`);
      // Offer the next node directly. We can't rely on the reposition's selection event:
      // VS Code already parks the caret at the end of the inserted text, so for a LEAF
      // the caret we set equals it — no selection change fires, and the next node (often
      // a climb-out) would stay silent until the human moved the cursor by hand.
      this.offerRecovery(editor);
      return;
    }

    const step = session.current();
    if (!step) return;
    const t0 = Date.now();
    const pos = editor.document.positionAt(session.anchorOffset + step.cursorOffset);
    editor.selection = new vscode.Selection(pos, pos);
    revealCursor(editor, pos);
    this.output.appendLine(
      `[disclosure] step ${session.index + 1}/${session.steps.length} accepted: ` +
        `reposition ${Date.now() - t0}ms`,
    );

    session.advance();
    if (session.done) {
      this.finish(session);
      return;
    }
    this.lastAcceptAt = Date.now();
  }

  // A buffer change while a walk is active. Before divergence: a change that isn't
  // our own accept flips the walk to recovery mode. After divergence: each human
  // keystroke drops the settled latch (suppressing the ghost so it doesn't flash) and
  // reschedules the settle, so the ghost re-offers only once typing stops. Our own
  // inserts/accepts (text == lastOffered) are ignored so we never loop.
  noteChange(e: vscode.TextDocumentChangeEvent): void {
    const s = this.session;
    if (!s) return;
    if (e.document.uri.toString() !== s.uri.toString()) return;

    if (this.diverged) {
      for (const c of e.contentChanges) {
        if (this.lastOffered && c.text === this.lastOffered.text) return; // our own insert/accept
        this.recoverySettled = false;
        this.scheduleGhost();
        return;
      }
      return;
    }

    for (const c of e.contentChanges) {
      if (c.text === "" && c.rangeLength === 0) continue;
      if (c.rangeOffset + c.rangeLength <= s.anchorOffset) continue; // edit above the symbol — not ours to recover
      if (this.lastOffered && c.text === this.lastOffered.text) continue; // our own accept
      this.setDiverged(true);
      this.recoverySettled = false;
      this.scheduleGhost();
      this.output.appendLine("[disclosure] divergence detected — recovery ghost re-anchors to your cursor");
      void vscode.window.setStatusBarMessage(
        "Human Replay: you took over — Tab keeps placing the planned nodes at your cursor",
        4000,
      );
      return;
    }
  }

  private clearSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
  }

  // Re-offer the recovery ghost once typing settles: raise the settled latch and offer
  // the next planned node (inline insert at the cursor, or a climb-out decoration).
  private scheduleGhost(): void {
    this.clearSettle();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      const editor = vscode.window.activeTextEditor;
      if (editor && this.diverged && this.session && editor.document.uri.toString() === this.session.uri.toString()) {
        this.recoverySettled = true;
        this.offerRecovery(editor);
      }
    }, SETTLE_MS);
  }

  // Offer the next planned node in recovery mode — at the human's caret, never
  // by moving it. Eligibility is the AST's verdict: the caret's innermost
  // container must be the node's parent. Outside it the walk waits (one status
  // hint per excursion says where the node lands); the next cursor rest inside
  // the container re-offers by itself. An unparseable symbol region counts as
  // eligible — Tab's re-anchored continue owns surfacing a real collision.
  private offerRecovery(editor: vscode.TextEditor): void {
    const s = this.session;
    const step = s?.current();
    if (!s || !step || !this.diverged || !this.recoverySettled) return;
    if (editor.document.uri.toString() !== s.uri.toString()) return;

    const symbolText = this.extractSymbol(editor.document);
    const cursorRel = editor.document.offsetAt(editor.selection.active) - s.anchorOffset;
    const eligible =
      symbolText === undefined || innermostContainerKey(symbolText, cursorRel, s.spec) === step.parentKey;
    this.setRecoveryEligible(eligible);
    if (!eligible) {
      if (!this.hintedIneligible) {
        this.hintedIneligible = true;
        const home = step.parentKey === "ROOT" ? "the function body" : `\`${step.parentKey.split("\n")[0].trim()}\``;
        void vscode.window.setStatusBarMessage(
          `Human Replay: walk waiting — the next node lands in ${home}. Move the cursor there, or re-run the step from the Replay Guide panel.`,
          6000,
        );
        this.output.appendLine(`[disclosure] recovery waiting — caret outside ${step.parentKey === "ROOT" ? "fn body" : step.parentKey}`);
      }
      return;
    }
    this.hintedIneligible = false;
    void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
  }

  // The live symbol text (from the anchor to the end of the function it builds),
  // so the re-anchor resolves against what the human actually has now.
  private extractSymbol(document: vscode.TextDocument): string | undefined {
    if (!this.session) return undefined;
    const tail = document.getText().slice(this.session.anchorOffset);
    const fn = findFunction(parseRoot(tail, this.session.spec), this.session.spec);
    return fn ? tail.slice(0, fn.endIndex) : undefined;
  }

  // Fallback when the recovery insert ghost can't render: Tab (gated on no inline
  // suggestion visible) places the next planned node by re-anchoring — parent
  // container + append at end of its body (anchoredInsert), preserving the human's
  // edits. A collision (the parent is gone) surfaces; it never guesses. The
  // reposition re-triggers the next ghost via onSelectionChanged.
  async continueWalk(editor: vscode.TextEditor): Promise<void> {
    // Tab re-entrancy latch: the step only advances after the awaited edit, so a
    // second Tab mid-flight would append the same node twice.
    if (this.continuing) return;
    this.continuing = true;
    try {
      await this.continueWalkInner(editor);
    } finally {
      this.continuing = false;
    }
  }

  private async continueWalkInner(editor: vscode.TextEditor): Promise<void> {
    const s = this.session;
    const step = s?.current();
    if (!s || !step) return;
    if (editor.document.uri.toString() !== s.uri.toString()) return; // never write another file
    this.clearSettle();
    this.recoverySettled = true; // an explicit Tab — the next ghost may show at once
    const symbolText = this.extractSymbol(editor.document);
    // Defense in depth behind the recoveryEligible context gate: a Tab that
    // slips through while the caret sits outside the node's container must not
    // place bytes the human didn't aim — hold, don't append.
    if (symbolText !== undefined) {
      const cursorRel = editor.document.offsetAt(editor.selection.active) - s.anchorOffset;
      if (innermostContainerKey(symbolText, cursorRel, s.spec) !== step.parentKey) {
        this.output.appendLine("[disclosure] tab held — caret outside the walk's container");
        return;
      }
    }
    const edit = symbolText !== undefined ? appendEdit(symbolText, step.parentKey, step.bareText, s.spec) : null;
    if (!edit) {
      await this.surfaceCollision();
      return;
    }
    const start = editor.document.positionAt(s.anchorOffset + edit.start);
    const end = editor.document.positionAt(s.anchorOffset + edit.end);
    // For a container, open a blank indented line inside its body and land the
    // cursor there — the descend feel, matching the happy path. (The blank line is
    // transient: the next child's append strips it.) For a leaf, land after it.
    let text = edit.text;
    let caretOff = s.anchorOffset + edit.start + edit.text.length;
    if (step.kind === "container") {
      const braceNl = text.indexOf("{\n");
      if (braceNl >= 0) {
        let i = 1;
        while (text[i] === " ") i++; // container's own indent = leading spaces of edit.text
        const innerIndent = i - 1 + 4;
        const at = braceNl + 2; // just past `{\n`
        text = text.slice(0, at) + " ".repeat(innerIndent) + "\n" + text.slice(at);
        caretOff = s.anchorOffset + edit.start + at + innerIndent;
      }
    }
    this.lastOffered = { offset: s.anchorOffset + edit.start, text }; // skip our own edit in noteChange
    await editor.edit((b) => b.replace(new vscode.Range(start, end), text));
    const caret = editor.document.positionAt(caretOff);
    editor.selection = new vscode.Selection(caret, caret);
    revealCursor(editor, caret);
    s.advance();
    this.output.appendLine(`[disclosure] continue (re-anchored) ${s.index}/${s.steps.length}`);
    if (s.done) this.finish(s);
  }

  // The next node has nowhere to land — its parent in the tree is gone. Mark the
  // step blocked (panel) and let the human end the symbol and finish it by hand.
  private async surfaceCollision(): Promise<void> {
    this.onCollision?.();
    this.output.appendLine("[disclosure] collision: next node's parent is gone — surfacing");
    await vscode.window.showWarningMessage(
      "Human Replay: the next node's place in the tree changed too much to fill automatically — finish this symbol by hand.",
      "OK",
    );
    this.end();
  }

  // Single trigger path. Baked: re-trigger the ghost when the cursor lands on the
  // current anchor. Recovery: re-trigger the insert ghost when the cursor settles
  // (drives the next ghost after an accept and restores one after wandering) — but
  // not mid-typing, where the settle timer owns the re-offer.
  //
  // Read the position from the selection-change EVENT, not the editor's current
  // selection: the accept fires two events (the insert, then our reposition) and
  // only the reposition event's position is the anchor, so this fires once.
  async onSelectionChanged(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<void> {
    const s = this.session;
    if (!s || document.uri.toString() !== s.uri.toString()) return;

    if (this.diverged) {
      if (this.settleTimer) return; // mid-typing — the settle timer owns the re-offer
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.toString() === s.uri.toString()) this.offerRecovery(editor);
      return;
    }

    const expected = this.expectedOffset();
    if (expected === undefined) return;
    if (document.offsetAt(position) !== expected) return;

    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    if (this.lastAcceptAt !== undefined) {
      this.output.appendLine(`[disclosure] retrigger ${Date.now() - this.lastAcceptAt}ms`);
      this.lastAcceptAt = undefined;
    }
  }
}
