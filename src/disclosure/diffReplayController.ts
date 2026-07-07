import * as vscode from "vscode";
import { buildReplaySteps, asInsertion, ReplayStep } from "./sequence";
import { lineDiffSteps, changedLineSpan } from "./lineDiff";
import { resolveStep, resolveStepNoTree, shiftWindow } from "./replay";
import { parseRoot } from "./diff";
import { LanguageSpec, RUST } from "./language";
import { revealCursor } from "./reveal";
import { Retrospective } from "../retrospective/retrospective";

const SETTLE_MS = 450; // wait for the human's typing to settle before re-anchoring

// Line span of a hunk's text — for the patch-grain evidence line, so a coarse
// hunk stays visible in the output channel rather than hiding as one healthy step.
// A single trailing newline terminates the last line, it does not open a new one.
function countLines(text: string): number {
  if (text === "") return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body === "" ? 1 : body.split("\n").length;
}

// Drives diff-replay — the edit-aware walk — over the native inline-completion
// surface. Where the insert walk (controller.ts) only opens new lines, this
// replays a diff: each step is a same-line replace or delete, served as a ghost
// *over the existing range* (InlineCompletionItem.range), Tab swaps it. A multi-
// line ADDITIVE op (a new argument or statement line) is served as an open-a-line
// ghost at one point — the same native surface, zero-width range. A multi-line
// BLOCK rewrite (replacing existing lines) isn't automated yet: the step still
// applies its other ops, then surfaces as blocked so it never reads as a false
// "done". Model-free.
//
// Each step re-anchors against the LIVE buffer before it is offered: the symbol
// region is re-parsed and the step's anchor resolved against the current tree, so
// an earlier accepted step (which shifted the bytes) never throws off a later one.
//
// Divergence (the human hand-edits mid-replay): the per-step re-anchor already
// absorbs a benign edit in a stable region — the next step still lands. Two things
// make that graceful rather than brittle. (1) A structural collision — the human
// edited away the very node a remaining step targets — resolves to null (not a
// throw) and SURFACES (panel blocked, finish by hand), like the insert walk. (2) A
// `typing` latch suppresses the ghost while keystrokes land and a settle re-anchors
// once they stop, so the replay doesn't flash or fight the edit. Model-free.
interface Session {
  uri: vscode.Uri;
  anchorOffset: number; // where the symbol begins in the document (fixed)
  symbolLen: number; // current byte length of the symbol region (moves as steps land)
  // Running length delta of OUR OWN accepted swaps, in symbol-local bytes. Later
  // steps' baked ranges shift by exactly this; resolveStep tries that arithmetic
  // first (byte-validated), surviving accepts that shift sibling index paths.
  selfDelta: number;
  steps: ReplayStep[];
  index: number;
  spec: LanguageSpec;
  retrospective?: Retrospective;
  // Where the retrospective anchors when the walk completes — the block the
  // human just replayed, in final-document coordinates. For a symbol swap that
  // is the symbol; for a Patch step (whole file) it is only the changed lines,
  // so the retrospective squiggle never spans code the step never touched.
  retroOffset: number;
  retroLen: number;
  lastServed?: { range: vscode.Range; text: string };
  // "dramatic" renders the change as a visual diff (old struck red, new ghosted
  // green) via decorations + a Tab keybinding, instead of the native ghost. Same
  // step model and live re-anchoring underneath; only the surface differs.
  dramatic?: boolean;
  // Patch steps: line-grain hunks over a whole file, resolved without a parse
  // (arithmetic + content legs; the file may have no grammar at all). The spec
  // field is unused in this mode.
  lineMode?: boolean;
  // An armed PENDING INSERT: the current step's bytes are already written into
  // the buffer, tinted, awaiting Tab (keep) or Shift+Esc (remove). Deltas are
  // booked at write time, so the range tracks human edits via noteChange.
  pending?: { start: number; length: number };
}

const DECORATION_CONTEXT = "humanReplay.diffDecorationActive";
// A diff-replay session is live. Gates the Tab-nudge keybinding: while a step
// is armed on the native surface, a ghost-less Tab must nudge the ghost or
// fall through to a real indent — never type bytes into the replay by accident.
const ACTIVE_CONTEXT = "humanReplay.diffReplayActive";

type ResolveResult =
  | { kind: "ok"; range: vscode.Range; text: string; cleanParse: boolean }
  | { kind: "collision"; cleanParse: boolean }
  | { kind: "skip" };

export class DiffReplayController {
  private session: Session | undefined;
  private onComplete?: (s: { uri: vscode.Uri; retroOffset: number; retroLen: number; retrospective?: Retrospective }) => void;
  private onCollision?: () => void;
  private lastAcceptAt: number | undefined;
  // The human authored mid-replay (re-anchoring engaged). `typing` is true between a
  // keystroke and the settle that follows it — currentItem returns nothing while it
  // is, so VS Code's per-keystroke auto re-query doesn't flash the ghost.
  private diverged = false;
  private typing = false;
  private accepting = false; // Tab re-entrancy latch: one decoration accept lands at a time
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  // The human edited the current step's own line (its doomed range) — they're taking
  // over THIS hunk. A collision there must HOLD, never alarm: surfacing is reserved
  // for a step the human didn't touch losing its anchor against a clean parse.
  private editedCurrentLine = false;
  // Outgoing (doomed) range and incoming (proposed) virtual text. One type each,
  // reused; the incoming text is set per-range via renderOptions.
  private readonly doomed: vscode.TextEditorDecorationType;
  private readonly incoming: vscode.TextEditorDecorationType;
  // Pending-insert tint: the incoming bytes live in the buffer, readable with
  // real syntax highlighting, until the human keeps or removes them.
  private readonly pendingTint: vscode.TextEditorDecorationType;
  // The gesture hint + hunk counter, ambient while a session runs. The native
  // ghost is VS Code's rendering (nothing can be appended to it), so the
  // status bar is where those hunks' gestures live; decoration hunks carry the
  // hint inline as well.
  private readonly gestures: vscode.StatusBarItem;

  constructor(private readonly output: vscode.OutputChannel) {
    this.doomed = vscode.window.createTextEditorDecorationType({
      textDecoration: "line-through",
      backgroundColor: "rgba(248, 81, 73, 0.18)",
    });
    this.incoming = vscode.window.createTextEditorDecorationType({});
    this.pendingTint = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(63, 185, 80, 0.14)",
      isWholeLine: true,
    });
    this.gestures = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  }

  dispose(): void {
    this.gestures.dispose();
    this.doomed.dispose();
    this.incoming.dispose();
    this.pendingTint.dispose();
  }

  private updateGestureHint(): void {
    const s = this.session;
    if (!s || s.index >= s.steps.length) {
      this.gestures.hide();
      return;
    }
    this.gestures.text = `$(diff) hunk ${s.index + 1}/${s.steps.length} — Tab applies · Shift+Esc skips`;
    this.gestures.tooltip = "Tab lands this hunk's sandbox bytes; Shift+Esc keeps yours and moves on; Esc cancels the step";
    this.gestures.show();
  }

  setCompletionHandler(handler: NonNullable<DiffReplayController["onComplete"]>): void {
    this.onComplete = handler;
  }

  // Fired when a re-anchored step can't place its node (the human edited the
  // structure away) — the panel marks the step blocked; the human finishes by hand.
  setCollisionHandler(handler: () => void): void {
    this.onCollision = handler;
  }

  isActive(document: vscode.TextDocument): boolean {
    return (
      !!this.session &&
      this.session.uri.toString() === document.uri.toString() &&
      this.session.index < this.session.steps.length
    );
  }

  // The current symbol text as it stands in the buffer (old + steps applied so far).
  private symbolText(document: vscode.TextDocument): string {
    const s = this.session!;
    const start = document.positionAt(s.anchorOffset);
    const end = document.positionAt(s.anchorOffset + s.symbolLen);
    return document.getText(new vscode.Range(start, end));
  }

  // How the current step renders. "replace" — a same-line swap (native ghost, or the
  // dramatic strike+ghost). "insert" — a multi-line additive op served as an open-a-
  // line ghost at one point. "block" — a multi-line rewrite of existing lines, not
  // automated yet (surfaced for hand-finishing).
  private surfaceOf(step: ReplayStep): "replace" | "insert" | "block" {
    if (step.singleLine) return "replace";
    return asInsertion(step.oldText, step.replacement) ? "insert" : "block";
  }

  // Every diff-replay step rides the decoration surface. This is now
  // EVIDENCE, not hypothesis: with the provider instrumented, an insert hunk
  // served the item three consecutive arms ("provider served the insert
  // ghost") and VS Code rendered none of them — in the same session where
  // five sibling inserts rendered fine. The native surface draws served items
  // at its own discretion; ours never fails. The preview cost (first line +
  // count instead of the full body) is the pending-bytes work item in
  // docs/pending-work.md. The disclosure walk keeps native ghosts — its
  // cursor-gated arms have never dropped.
  private ridesDecoration(_s: Session, _step: ReplayStep): boolean {
    return true;
  }

  // Resolve the current step's live document range by re-anchoring against the
  // current symbol tree. Three outcomes:
  //   - { kind: "ok", range, text } — serve it. For an "insert" the range is zero-
  //     width at the insertion point and `text` is the bytes to add;
  //   - { kind: "collision", cleanParse } — the anchor is gone. `cleanParse` is
  //     false when the buffer is mid-edit (ERROR nodes): the caller HOLDS instead of
  //     alarming, because the human is still typing. True means the structure really
  //     changed (e.g. the loop deleted);
  //   - { kind: "skip" } — no step left.
  private resolveCurrent(document: vscode.TextDocument): ResolveResult {
    const s = this.session;
    const step = s?.steps[s.index];
    if (!s || !step) return { kind: "skip" };
    const surface = this.surfaceOf(step);
    const symText = this.symbolText(document);
    // Line mode never parses: hunks live between lines, and the file may have no
    // grammar (shell). Arithmetic + content legs only; cleanParse is moot (true
    // keeps collisions surfacing instead of holding forever).
    let r: [number, number] | null;
    let cleanParse: boolean;
    if (s.lineMode) {
      cleanParse = true;
      r = resolveStepNoTree(symText, step, s.selfDelta);
    } else {
      const root = parseRoot(symText, s.spec);
      cleanParse = !root.hasError;
      // Arithmetic (baked range + our own accepts' delta, byte-validated) → structural
      // anchor (byte-validated) → unique-substring content match. The arithmetic leg
      // survives our own accepts shifting sibling index paths (an added comment line
      // renumbers everything after it); the content leg survives the human's on-line
      // edit drifting the path to a valid-but-wrong node. All gone → collision.
      r = resolveStep(symText, root, step, s.selfDelta);
    }
    if (!r) return { kind: "collision", cleanParse };

    if (surface === "insert") {
      const ins = asInsertion(step.oldText, step.replacement)!;
      const point = document.positionAt(s.anchorOffset + (ins.atEnd ? r[1] : r[0]));
      return { kind: "ok", range: new vscode.Range(point, point), text: ins.text, cleanParse };
    }
    const range = new vscode.Range(
      document.positionAt(s.anchorOffset + r[0]),
      document.positionAt(s.anchorOffset + r[1]),
    );
    return { kind: "ok", range, text: step.replacement, cleanParse };
  }

  // Ghost for the current step — shown when the cursor is on the doomed line.
  // Unlike an insert (which lands at one point, so the gate pins the exact
  // offset), a replace's range is explicit — VS Code swaps it wherever the cursor
  // sits — so pinning a column buys no safety and feels broken. Gate on the line.
  currentItem(document: vscode.TextDocument, position: vscode.Position): vscode.InlineCompletionItem | undefined {
    const s = this.session;
    const step = s?.steps[s.index];
    if (!s || !step) return undefined;
    // Every decline logs while a native-surface step is armed: three "no
    // ghost, dead Tab" incidents were diagnosed blind because nothing said
    // whether VS Code even queried the provider.
    if (this.typing) return undefined; // suppress the ghost mid-keystroke — settle re-offers
    if (this.ridesDecoration(s, step)) return undefined; // decoration steps never serve a native item
    const resolved = this.resolveCurrent(document);
    if (resolved.kind !== "ok" || !resolved.cleanParse) {
      this.output.appendLine(`[diff-replay] provider declined: ${resolved.kind === "ok" ? "dirty parse" : resolved.kind}`);
      return undefined;
    }
    if (position.line !== resolved.range.start.line) {
      this.output.appendLine(`[diff-replay] provider declined: query at line ${position.line + 1}, armed at ${resolved.range.start.line + 1}`);
      return undefined;
    }

    s.lastServed = { range: resolved.range, text: resolved.text };
    this.output.appendLine(`[diff-replay] provider served the insert ghost (${resolved.text.split("\n").length} line(s))`);
    const item = new vscode.InlineCompletionItem(resolved.text, resolved.range);
    item.command = { command: "humanReplay.diffReplayAccepted", title: "Human Replay: next diff-replay step" };
    return item;
  }

  async start(
    editor: vscode.TextEditor,
    oldSrc: string,
    newSrc: string,
    retrospective?: Retrospective,
    dramatic = false,
    inPlace = false,
    spec: LanguageSpec = RUST,
    lineMode = false,
  ): Promise<void> {
    // Demo path: seed the branch's current code so there is something to modify.
    // Real replay (inPlace): the symbol already lives in the workspace at the cursor
    // (oldSrc was resolved from it), so anchor on it and don't duplicate it.
    const at = editor.selection.active;
    if (!inPlace) await editor.edit((b) => b.insert(at, oldSrc));
    const anchorOffset = editor.document.offsetAt(at);
    const steps = lineMode ? lineDiffSteps(oldSrc, newSrc) : buildReplaySteps(oldSrc, newSrc, spec);
    // A symbol swap anchors the retrospective on the whole symbol (it IS the
    // block). A Patch step spans the whole file, so anchor on the changed lines
    // only — a whole-file squiggle buries the code the human is reading.
    const span = lineMode ? changedLineSpan(oldSrc, newSrc) : undefined;
    const retroOffset = span ? anchorOffset + span.offset : anchorOffset;
    const retroLen = span ? span.len : newSrc.length || oldSrc.length;
    this.session = { uri: editor.document.uri, anchorOffset, symbolLen: oldSrc.length, selfDelta: 0, steps, index: 0, retrospective, dramatic, spec, lineMode, retroOffset, retroLen };
    void vscode.commands.executeCommand("setContext", ACTIVE_CONTEXT, true);
    this.lastAcceptAt = undefined;
    this.diverged = false;
    this.typing = false;
    this.editedCurrentLine = false;
    this.clearSettle();
    const tally = steps.reduce(
      (a, s) => ((a[this.surfaceOf(s)] = (a[this.surfaceOf(s)] ?? 0) + 1), a),
      {} as Record<string, number>,
    );
    const maxHunkLines = lineMode
      ? steps.reduce((mx, s) => Math.max(mx, countLines(s.originalText ?? ""), countLines(s.replacement)), 0)
      : 0;
    this.output.appendLine(
      `[diff-replay] start${dramatic ? " (dramatic)" : ""}: ${steps.length} steps ` +
        `(${tally.replace ?? 0} replace, ${tally.insert ?? 0} insert, ${tally.block ?? 0} block)` +
        (lineMode ? `, widest hunk ${maxHunkLines} line(s)` : ""),
    );
    this.renderCurrent(editor);
  }

  cancel(): void {
    if (!this.session) return;
    this.output.appendLine(`[diff-replay] cancelled at step ${this.session.index}`);
    this.gestures.hide();
    const editor = vscode.window.activeTextEditor;
    // Unratified pending bytes must not survive a cancel (fire-and-forget:
    // the session is going away either way; a failure logs).
    if (this.session.pending && editor && editor.document.uri.toString() === this.session.uri.toString()) {
      void this.removePending(editor).catch((e) =>
        this.output.appendLine(`[diff-replay] pending cleanup failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    if (editor) this.clearDecorations(editor);
    void vscode.commands.executeCommand("setContext", DECORATION_CONTEXT, false);
    void vscode.commands.executeCommand("setContext", ACTIVE_CONTEXT, false);
    this.clearSettle();
    this.session = undefined;
  }

  /** Tab with no ghost up while a step is armed: re-trigger the ghost when the
   *  cursor sits on the armed line, and report whether we did. The caller runs
   *  the editor's default Tab when we didn't — Tab must never be a dead key,
   *  and it must never type bytes into an armed replay line by accident (the
   *  stray-indent corruption, feedback.md #5). */
  async nudge(editor: vscode.TextEditor): Promise<boolean> {
    const s = this.session;
    const step = s?.steps[s.index];
    if (!s || !step || this.typing) return false;
    if (editor.document.uri.toString() !== s.uri.toString()) return false;
    if (this.ridesDecoration(s, step)) return false; // decoration Tab owns that surface
    const resolved = this.resolveCurrent(editor.document);
    if (resolved.kind !== "ok" || !resolved.cleanParse) return false;
    if (editor.selection.active.line !== resolved.range.start.line) return false;
    this.output.appendLine("[diff-replay] tab nudged the ghost");
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    return true;
  }

  // After VS Code applied the accepted replacement: book the length delta, advance,
  // and reposition onto the next step's range start (the move re-triggers its ghost).
  onAccepted(editor: vscode.TextEditor): void {
    const s = this.session;
    const served = s?.lastServed;
    if (!s || !served) return;

    const t0 = Date.now();
    const replacedLen = editor.document.offsetAt(served.range.end) - editor.document.offsetAt(served.range.start);
    s.symbolLen += served.text.length - replacedLen;
    s.selfDelta += served.text.length - replacedLen;
    s.index++;
    this.diverged = false; // a planned step landed — back on the rails
    this.editedCurrentLine = false;
    this.clearDecorations(editor); // drop a block-replace's red strike once it lands
    this.output.appendLine(
      `[diff-replay] step ${s.index}/${s.steps.length} accepted: reposition ${Date.now() - t0}ms`,
    );

    this.renderCurrent(editor);
    this.lastAcceptAt = Date.now();
  }

  // A buffer change while a replay is active. Our own accept/swap (its text matches
  // the served replacement) is ignored. A human edit engages re-anchoring: drop the
  // ghost (typing latch) and reschedule the settle, so the remaining steps re-anchor
  // once typing stops rather than flashing or fighting the edit. If the edit touches
  // the current step's own line, the human is taking over that hunk — note it so a
  // collision there holds instead of alarming, and drop the now-stale strike.
  noteChange(e: vscode.TextDocumentChangeEvent): void {
    const s = this.session;
    if (!s || e.document.uri.toString() !== s.uri.toString()) return;
    let humanEdited = false;
    for (const c of e.contentChanges) {
      if (c.text === s.lastServed?.text) continue; // our own accept/swap — symbolLen booked at accept

      // Keep the symbol window aligned with the human's insertion/deletion, or every
      // re-parse reads a buffer that is `delta` bytes off — a one-char insert truncates
      // the closing brace, the parse errors, and the re-anchor holds forever.
      const w = shiftWindow(s, { rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, textLength: c.text.length });
      s.anchorOffset = w.anchorOffset;
      s.symbolLen = w.symbolLen;

      // Keep the pending range on its bytes too, or a skip after a human edit
      // above it would delete the wrong span.
      if (s.pending) {
        const delta = c.text.length - c.rangeLength;
        if (c.rangeOffset + c.rangeLength <= s.pending.start) s.pending.start += delta;
        else if (c.rangeOffset < s.pending.start + s.pending.length) s.pending.length += delta;
      }

      const doomed = s.lastServed?.range;
      if (doomed && c.range.start.line <= doomed.end.line && doomed.start.line <= c.range.end.line) {
        this.editedCurrentLine = true; // they're editing the very line being replaced
        if (s.dramatic) {
          const editor = vscode.window.activeTextEditor;
          if (editor && editor.document.uri.toString() === s.uri.toString()) this.clearDecorations(editor);
        }
      }
      humanEdited = true;
    }
    if (!humanEdited) return;

    if (!this.diverged) {
      this.diverged = true;
      this.output.appendLine("[diff-replay] divergence detected — re-anchoring the remaining steps");
      void vscode.window.setStatusBarMessage(
        "Human Replay: you took over — the replay re-anchors to your edits",
        4000,
      );
    }
    this.typing = true;
    this.scheduleSettle();
  }

  private clearSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
  }

  // Re-anchor the current step once typing settles. Re-offer WITHOUT yanking the
  // cursor — re-render the decoration in place (dramatic) or re-trigger the ghost
  // where the human is (native). A broken anchor either HOLDS (the human is mid-edit
  // or editing this very hunk — no alarm) or, only when the buffer parses clean and
  // the break is a hunk the human didn't touch, SURFACES.
  private scheduleSettle(): void {
    this.clearSettle();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.typing = false;
      const editor = vscode.window.activeTextEditor;
      const s = this.session;
      if (!editor || !s || editor.document.uri.toString() !== s.uri.toString()) return;
      const res = this.resolveCurrent(editor.document);
      if (res.kind === "skip") return; // nothing serveable; leave the buffer to the human

      // A pending insert's bytes are already applied — the settle only needs
      // to repaint the (possibly shifted) tint, never re-resolve or re-apply.
      if (s.pending) {
        this.showPending(editor);
        return;
      }
      // Re-anchor only off a CLEAN parse — a half-typed line resolves to a garbage
      // range, so never re-render/serve from one.
      if (res.kind === "ok" && res.cleanParse) {
        this.editedCurrentLine = false; // re-anchored cleanly — back on track
        if (this.ridesDecoration(s, s.steps[s.index])) this.renderDecoration(editor, res.range, res.text, false);
        else void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        return;
      }

      // Surface ONLY a clean-parse collision on a hunk the human didn't touch — a
      // genuine structural change that stranded a planned step. Everything else —
      // mid-edit (dirty parse), a garbage resolve, or the human editing this very
      // hunk — HOLDS silently. No alarm while they're shaping the line.
      if (res.kind === "collision" && res.cleanParse && !this.editedCurrentLine) {
        void this.surfaceCollision(editor);
        return;
      }
      this.output.appendLine(
        `[diff-replay] holding step ${s.index} (${this.editedCurrentLine ? "you're editing this hunk" : "buffer mid-edit"})`,
      );
    }, SETTLE_MS);
  }

  // The one policy for a current-step anchor that no longer resolves, shared by
  // every path (settle and the drive paths). The predicate is the settle's: surface
  // ONLY a genuine structural break on a hunk the human didn't touch, seen against a
  // clean parse. If they edited this very hunk, they've taken it over — "advance"
  // (retire the step, no alarm). If the buffer is mid-edit (dirty parse) on a hunk
  // they didn't touch, "hold" — the settle re-anchors once typing stops.
  private collisionAction(cleanParse: boolean): "surface" | "advance" | "hold" {
    if (this.editedCurrentLine) return "advance";
    if (cleanParse) return "surface";
    return "hold";
  }

  // A re-anchored step has nowhere to land — an edit the human didn't make on this
  // hunk removed its node. Mark the step blocked (panel), drop the session, and let
  // them finish by hand.
  private async surfaceCollision(editor: vscode.TextEditor): Promise<void> {
    this.onCollision?.();
    this.output.appendLine("[diff-replay] collision: a step's node was edited away — surfacing");
    this.clearSettle();
    this.gestures.hide();
    this.clearDecorations(editor);
    void vscode.commands.executeCommand("setContext", DECORATION_CONTEXT, false);
    this.session = undefined;
    await vscode.window.showWarningMessage(
      "Human Replay: your edit changed the structure this replay targets — finish this symbol by hand.",
      "OK",
    );
  }

  /** Decline the current hunk and move to the next — the "keep my line, take
   *  the rest" gesture. A patch step converges the file on the sandbox, so a
   *  human addition shows up as a deletion hunk; skipping it is the human
   *  overruling that one delta without abandoning the step. The file then ends
   *  off the sandbox bytes on purpose — resume derivation reads it as pending,
   *  which is the honest verdict. */
  skipCurrent(editor: vscode.TextEditor): void {
    const s = this.session;
    const step = s?.steps[s.index];
    if (!s || !step) return;
    this.clearSettle();
    const removal = s.pending ? this.removePending(editor) : Promise.resolve();
    void removal
      .then(() => {
        s.index++;
        this.editedCurrentLine = false;
        this.clearDecorations(editor);
        this.output.appendLine(`[diff-replay] hunk ${s.index}/${s.steps.length} skipped by the human`);
        this.renderCurrent(editor);
      })
      .catch((e) => this.output.appendLine(`[diff-replay] skip failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Single trigger path: a cursor landing on the current step's range start asks
  // for the ghost (next step after an accept, or a restored ghost after wandering).
  async onSelectionChanged(document: vscode.TextDocument, position: vscode.Position): Promise<void> {
    const s = this.session;
    const step = s?.steps[s.index];
    if (!s || !step) return;
    if (s.dramatic && this.surfaceOf(step) === "replace") return; // decoration persists until accept; no re-trigger
    if (this.typing) return; // mid-typing — the settle owns the re-offer
    const resolved = this.resolveCurrent(document);
    if (resolved.kind !== "ok") return; // a collision surfaces/holds via the drive path
    if (document.uri.toString() !== s.uri.toString()) return;
    if (position.line !== resolved.range.start.line) return;
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    if (this.lastAcceptAt !== undefined) {
      this.output.appendLine(`[diff-replay] retrigger ${Date.now() - this.lastAcceptAt}ms`);
      this.lastAcceptAt = undefined;
    }
  }

  // Render the current step on the surface its shape needs, then drive the walk to
  // its next stop. Three surfaces:
  //   - single-line replace, dramatic: strike red + green contentText decoration;
  //   - insert (open-a-line), any mode: native ghost at a zero-width point;
  //   - multi-line BLOCK (replace or delete): strike red, Tab applies (decoration
  //     accept). A replace previews its first incoming line beside the strike — a
  //     decoration's contentText can't draw newlines, and the native inline surface
  //     won't render a multi-line replacement from a mid-line range at all.
  private renderCurrent(editor: vscode.TextEditor): void {
    const s = this.session;
    if (!s) return;
    this.updateGestureHint();
    if (s.index >= s.steps.length) {
      this.complete(editor);
      return;
    }
    const resolved = this.resolveCurrent(editor.document);
    if (resolved.kind === "collision") {
      if (this.collisionAction(resolved.cleanParse) === "surface") void this.surfaceCollision(editor);
      else this.output.appendLine(`[diff-replay] holding step ${s.index} (you're editing this hunk / mid-edit)`);
      return;
    }
    if (resolved.kind === "skip") {
      this.complete(editor);
      return;
    }
    if (this.surfaceOf(s.steps[s.index]) === "insert") {
      // Pure inserts arm as PENDING BYTES: the body goes into the buffer
      // tinted green — full preview, real syntax highlighting, our surface.
      void this.armPendingInsert(editor, resolved.range.start, resolved.text).catch((e) => {
        this.output.appendLine(`[diff-replay] pending insert failed: ${e instanceof Error ? e.message : String(e)}`);
      });
      return;
    }
    if (this.ridesDecoration(s, s.steps[s.index])) {
      this.renderDecoration(editor, resolved.range, resolved.text, true);
      return;
    }
    // Native ghost: insert, or a non-dramatic single-line replace. Turn the
    // decoration Tab keybinding off so Tab accepts the inline suggestion.
    void vscode.commands.executeCommand("setContext", DECORATION_CONTEXT, false);
    editor.setDecorations(this.doomed, []);
    editor.setDecorations(this.incoming, []);
    s.lastServed = { range: resolved.range, text: resolved.text };
    editor.selection = new vscode.Selection(resolved.range.start, resolved.range.start);
    revealCursor(editor, resolved.range.start);
    this.output.appendLine(
      `[diff-replay] step ${s.index + 1}/${s.steps.length} armed: ${this.surfaceOf(s.steps[s.index])} ghost at line ${resolved.range.start.line + 1}`,
    );
    void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    // A trigger fired from inside the previous ghost's accept command can be
    // swallowed by the inline-suggest controller mid-accept (the file-walk
    // chains sessions accept-to-arm). One more nudge on the next tick lands
    // after the accept settles; the provider gates it, so a stray is harmless.
    setTimeout(() => void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger"), 50);
  }

  // Write the insert's bytes at the point, tinted, and book the deltas NOW —
  // the hunk is applied; Tab confirms it, Shift+Esc deletes it back out. The
  // write is flagged via lastServed so noteChange reads it as ours.
  private async armPendingInsert(editor: vscode.TextEditor, at: vscode.Position, text: string): Promise<void> {
    const s = this.session;
    if (!s) return;
    s.lastServed = { range: new vscode.Range(at, at), text };
    const applied = await editor.edit((b) => b.insert(at, text));
    if (!applied) throw new Error("pending insert edit rejected");
    const start = editor.document.offsetAt(at);
    s.symbolLen += text.length;
    s.selfDelta += text.length;
    s.pending = { start, length: text.length };
    this.showPending(editor);
    void vscode.commands.executeCommand("setContext", DECORATION_CONTEXT, true);
    this.updateGestureHint();
    this.output.appendLine(
      `[diff-replay] step ${s.index + 1}/${s.steps.length} armed: pending bytes at line ${at.line + 1} (${text.split("\n").length - 1} line(s))`,
    );
    editor.selection = new vscode.Selection(at, at);
    revealCursor(editor, at);
  }

  // (Re)paint the pending range — also the settle path's re-render, since the
  // range tracks human edits via noteChange.
  private showPending(editor: vscode.TextEditor): void {
    const s = this.session;
    if (!s?.pending) return;
    const start = editor.document.positionAt(s.pending.start);
    const end = editor.document.positionAt(s.pending.start + s.pending.length);
    editor.setDecorations(this.pendingTint, [new vscode.Range(start, end)]);
    const firstLineEnd = editor.document.lineAt(start.line).range.end;
    editor.setDecorations(this.incoming, [
      {
        range: new vscode.Range(firstLineEnd, firstLineEnd),
        renderOptions: { after: { contentText: "  ⟵ incoming (Tab keeps · Shift+Esc removes)", color: "#3fb950", fontStyle: "italic" } },
      },
    ]);
  }

  // Confirm the pending bytes: they are already in the buffer and booked, so
  // keeping them is pure bookkeeping.
  private keepPending(editor: vscode.TextEditor): void {
    const s = this.session!;
    s.pending = undefined;
    s.index++;
    this.diverged = false;
    this.editedCurrentLine = false;
    this.clearDecorations(editor);
    editor.setDecorations(this.pendingTint, []);
    this.output.appendLine(`[diff-replay] step ${s.index}/${s.steps.length} pending bytes kept`);
    this.renderCurrent(editor);
  }

  // Remove the pending bytes and un-book them — the human declined this hunk.
  private async removePending(editor: vscode.TextEditor): Promise<void> {
    const s = this.session!;
    const p = s.pending!;
    s.pending = undefined;
    const range = new vscode.Range(editor.document.positionAt(p.start), editor.document.positionAt(p.start + p.length));
    s.lastServed = { range, text: "" };
    await editor.edit((b) => b.delete(range));
    s.symbolLen -= p.length;
    s.selfDelta -= p.length;
    editor.setDecorations(this.pendingTint, []);
  }

  // --- dramatic mode: render the change as a visual diff ---------------------

  // Paint the doomed range (struck red) and ghost the new text in green beside it.
  // The render half of the dramatic step, shared by the first show and the settle
  // re-anchor (which passes reposition=false so it never yanks the cursor).
  private renderDecoration(editor: vscode.TextEditor, range: vscode.Range, text: string, reposition: boolean): void {
    this.session!.lastServed = { range, text };
    editor.setDecorations(this.doomed, [range]);
    // contentText can't draw newlines: a block previews its first incoming line
    // and says how much more Tab will land.
    const lines = text.split("\n");
    const hint =
      lines.length > 1
        ? `  ⟶  ${lines[0].trim()} … (+${lines.length - 1} more line${lines.length > 2 ? "s" : ""} — Tab applies · Shift+Esc skips)`
        : `  ⟶  ${text}   (Tab · Shift+Esc skips)`;
    // Anchor the hint at the end of the range's FIRST line. An `after`
    // attachment renders at the range end, and a multi-line hunk's range ends
    // past its trailing newline — the hint would land on the next content
    // line, shoving it sideways two lines below the strike.
    const firstLineEnd = editor.document.lineAt(range.start.line).range.end;
    editor.setDecorations(this.incoming, [
      {
        range: new vscode.Range(firstLineEnd, firstLineEnd),
        renderOptions: { after: { contentText: hint, color: "#3fb950", fontStyle: "italic" } },
      },
    ]);
    void vscode.commands.executeCommand("setContext", DECORATION_CONTEXT, true);
    this.output.appendLine(
      `[diff-replay] step ${this.session!.index + 1}/${this.session!.steps.length} armed: decoration at line ${range.start.line + 1}`,
    );
    if (reposition) {
      editor.selection = new vscode.Selection(range.start, range.start);
      revealCursor(editor, range.start);
    }
  }

  // Tab in dramatic mode: apply the swap, book the delta, advance, show the next.
  // Re-resolve against the live buffer at accept time — the human may have edited
  // since the decoration was shown — so the swap lands on the current range, and a
  // structural collision surfaces instead of clobbering the wrong span.
  /** Returns false ONLY when no session owns the gesture (a stale context key
   *  kept the Tab binding alive) — the caller falls through to a real indent
   *  so Tab is never a silent dead key. Held/holding outcomes return true:
   *  they are deliberate waits, and they log. */
  async acceptDecoration(editor: vscode.TextEditor): Promise<boolean> {
    // Tab faster than an edit resolves and the same step lands twice: everything
    // below re-resolves the CURRENT step, and index only advances after the
    // awaited edit. One accept in flight at a time; extra Tabs drop.
    if (this.accepting) {
      this.output.appendLine("[diff-replay] tab ignored — an accept is already in flight");
      return true;
    }
    if (!this.session) {
      this.output.appendLine("[diff-replay] tab: decoration context is stale (no session) — falling through to indent");
      void vscode.commands.executeCommand("setContext", DECORATION_CONTEXT, false);
      return false;
    }
    this.accepting = true;
    try {
      await this.acceptDecorationInner(editor);
    } finally {
      this.accepting = false;
    }
    return true;
  }

  private async acceptDecorationInner(editor: vscode.TextEditor): Promise<void> {
    const s = this.session;
    if (!s) return; // only reachable while a decoration is shown (DECORATION_CONTEXT set)
    this.clearSettle();
    if (s.pending) {
      // The bytes are already in the buffer — Tab confirms, no re-apply.
      this.keepPending(editor);
      return;
    }
    const resolved = this.resolveCurrent(editor.document);
    if (resolved.kind === "collision") {
      const action = this.collisionAction(resolved.cleanParse);
      if (action === "surface") {
        await this.surfaceCollision(editor);
        return;
      }
      if (action === "hold") {
        this.output.appendLine(`[diff-replay] tab on step ${s.index} held (buffer mid-edit)`);
        return;
      }
      // advance: the human rewrote this hunk's line themselves — retire the step and
      // move to the next one. Don't clobber their edit, don't alarm.
      this.output.appendLine(`[diff-replay] step ${s.index} taken over by hand — advancing`);
      s.index++;
      this.editedCurrentLine = false;
      this.diverged = false;
      this.clearDecorations(editor);
      this.renderCurrent(editor);
      return;
    }
    if (resolved.kind === "skip") {
      this.complete(editor);
      return;
    }
    const t0 = Date.now();
    const replacedLen = editor.document.offsetAt(resolved.range.end) - editor.document.offsetAt(resolved.range.start);
    s.lastServed = { range: resolved.range, text: resolved.text }; // so noteChange recognizes our own swap
    await editor.edit((b) => b.replace(resolved.range, resolved.text));
    s.symbolLen += resolved.text.length - replacedLen;
    s.selfDelta += resolved.text.length - replacedLen;
    s.index++;
    this.diverged = false; // a planned step landed — back on the rails
    this.editedCurrentLine = false;
    this.clearDecorations(editor);
    this.output.appendLine(`[diff-replay] step ${s.index}/${s.steps.length} accepted (dramatic) ${Date.now() - t0}ms`);
    this.renderCurrent(editor);
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.doomed, []);
    editor.setDecorations(this.incoming, []);
    editor.setDecorations(this.pendingTint, []);
  }

  // Single completion path for both modes: clear UI, drop the session, fire the hook.
  private complete(editor: vscode.TextEditor): void {
    const s = this.session;
    if (!s) return;
    this.clearSettle();
    this.gestures.hide();
    this.clearDecorations(editor);
    void vscode.commands.executeCommand("setContext", DECORATION_CONTEXT, false);
    void vscode.commands.executeCommand("setContext", ACTIVE_CONTEXT, false);
    this.output.appendLine(`[diff-replay] complete (${s.steps.length} steps)`);
    const done = { uri: s.uri, retroOffset: s.retroOffset, retroLen: s.retroLen, retrospective: s.retrospective };
    this.session = undefined;
    this.onComplete?.(done);
  }
}
