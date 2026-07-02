import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ReplayGuide, ReplayStep, parseGuide } from "./guide";
import { DisclosureController } from "./controller";
import { ReplayOrchestrator } from "./orchestrator";
import { parseRoot } from "./diff";
import { findItemByName, leadingTriviaStart, walkableSource, SyntaxNode } from "./walk";
import { planCreateInsertion, separatorToInsert, splitLeadingPad } from "./insertion";
import { ProgramCounter, StepStatus } from "./programCounter";
import { extractSymbol, stepAlreadyLanded } from "./resume";
import { LanguageSpec, languageForFile } from "./language";

export { StepStatus };

// Drives a loaded replay guide: holds the parsed guide and the program counter
// (the step the human is on), opens the step's target file, parks the cursor on
// the insertion point, and routes the step to the right engine. Model-free — the
// route is the step's action, read from the canonical guide, not a judgment.
//
//   create → disclosure walk of the new symbol (after)
//   modify → orchestrator.start(before, after): the classifier picks surgical vs rewrite
//   delete → strike the old symbol whole (the orchestrator's rewrite strike, empty target)
//
// The human should never have to find the spot themselves: a step carries its file
// (and optionally a `:line`), and the runner brings them there ready to Tab. A create
// lands where the sandbox says the symbol lives — inside the matching container for a
// nested symbol (a method in an impl/class), on a fresh separated line at end-of-file
// for a top-level one. Modify/delete land on the existing symbol. The program counter
// is the replay's position.

export class GuideRunner {
  private guide: ReplayGuide | undefined;
  private readonly pc = new ProgramCounter();
  private onChange?: () => void; // fired when state changes, so the panel refreshes
  // The sandbox this session replays from. Set by the Start Replay picker; the
  // humanReplay.sandboxRoot config is the fallback so a hand-configured run
  // still works.
  private sessionSandboxRoot: string | undefined;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly disclosure: DisclosureController,
    private readonly orchestrator: ReplayOrchestrator,
  ) {}

  setChangeHandler(handler: () => void): void {
    this.onChange = handler;
  }
  private changed(): void {
    this.onChange?.();
  }

  /** Display status of step `i` for the panel. */
  status(i: number): StepStatus {
    return this.pc.status(i);
  }

  /** Skip a step — it won't count as done, and the run advances past it. Skipping
   *  the step that is mid-walk also tears the walk down (decorations, contexts)
   *  and flows into the next step; a skip is "move on", not just a bookkeeping
   *  mark that leaves the human staring at a stuck strike. */
  skip(i: number): void {
    const wasInFlight = this.pc.inFlightIndex === i;
    this.pc.skip(i);
    if (wasInFlight) {
      this.disclosure.cancel();
      this.orchestrator.cancelAll();
    }
    this.output.appendLine(`[guide] step ${this.guide?.steps[i]?.id ?? i} skipped${wasInFlight ? " (walk cancelled)" : ""}`);
    this.changed();
    if (wasInFlight) {
      const next = this.pc.next();
      if (next < this.steps.length) void this.runStep(next, () => {});
    }
  }

  /** A re-anchored continue collided — mark the in-flight step blocked. */
  markCurrentBlocked(): void {
    if (this.pc.block()) this.changed();
  }

  /** Cancel Replay: the caller tears the engines down; clear the counter's
   *  in-flight mark so nothing can complete the cancelled step behind the
   *  human's back. The step keeps its status for a re-run. */
  cancelInFlight(): void {
    if (this.pc.cancelInFlight()) this.changed();
  }

  /** A step's interactive walk finished — advance the counter past it and flow
   *  straight into the next step (open it, park the cursor, show its first ghost),
   *  so the human tabs across step boundaries without clicking. Esc interrupts by
   *  cancelling the teed-up walk. No-op when no guide step was in flight (a legacy
   *  fixture command completing). The auto-advance keeps the just-set retrospective
   *  visible — it passes a no-op clear, unlike a manual run. */
  completeCurrent(): void {
    if (!this.pc.complete()) return;
    this.changed();
    const next = this.pc.next();
    if (next < this.steps.length) void this.runStep(next, () => {});
  }

  get loaded(): boolean {
    return this.guide !== undefined;
  }

  get feature(): string | undefined {
    return this.guide?.feature;
  }

  get steps(): readonly ReplayStep[] {
    return this.guide?.steps ?? [];
  }

  /** The step the panel highlights (in-flight, else next to run). */
  get counter(): number {
    return this.pc.position();
  }

  get isComplete(): boolean {
    return this.pc.isComplete;
  }

  load(md: string): ReplayGuide {
    const guide = parseGuide(md); // throws loud on a malformed guide (invariant 3)
    this.guide = guide;
    this.pc.reset(guide.steps.length);
    this.changed();
    this.output.appendLine(
      `[guide] loaded "${guide.feature}": ${guide.steps.length} step(s), ` +
        `${guide.invariants.length} invariant(s)`,
    );
    return guide;
  }

  setSandboxRoot(root: string | undefined): void {
    this.sessionSandboxRoot = root;
  }

  get sandboxRoot(): string | undefined {
    const configured = vscode.workspace.getConfiguration("humanReplay").get<string>("sandboxRoot", "").trim();
    return this.sessionSandboxRoot ?? (configured || undefined);
  }

  /** The persistable position (done + skipped) for workspaceState. */
  snapshot(): { done: number[]; skipped: number[] } {
    return this.pc.snapshot();
  }

  /** Merge a persisted position back in (union with live progress). */
  restore(s: { done?: number[]; skipped?: number[] }): void {
    this.pc.restore(s);
    this.changed();
  }

  // Resume from ground truth: a step whose target symbol already byte-matches the
  // sandbox (or, for delete, is already gone) was landed by a previous session —
  // mark it done. Reads both trees from disk, so it works before any editor opens
  // and survives reloads, out-of-band edits, and a lost saved position. Returns
  // how many steps it marked.
  deriveLanded(workspaceRoot: string): number {
    const sandbox = this.sandboxRoot;
    let landed = 0;
    this.steps.forEach((step, i) => {
      if (this.pc.status(i) === "done" || this.pc.status(i) === "skipped") return;
      const rel = step.file.split(":")[0];
      // A whole-file step (create-file, patch) compares whole files; symbol
      // steps compare the named item in the file's language. No language, no
      // verdict (fail closed).
      const wholeFile = step.action === "create-file" || step.action === "patch";
      const spec = languageForFile(rel);
      if (!wholeFile && !spec) return;
      const read = (root: string) =>
        wholeFile
          ? this.readFileFromDisk(path.join(root, rel))
          : this.readSymbolFromDisk(path.join(root, rel), step.symbol, spec!);
      const target = read(workspaceRoot);
      const after = sandbox ? read(sandbox) : undefined;
      if (stepAlreadyLanded(step.action, target, after)) {
        this.pc.markDone(i);
        landed++;
        this.output.appendLine(`[guide] step ${step.id} already landed (target matches sandbox) — marked done`);
      }
    });
    if (landed > 0) this.changed();
    return landed;
  }

  private readSymbolFromDisk(file: string, symbol: string, spec: LanguageSpec): string | undefined {
    try {
      return extractSymbol(fs.readFileSync(file, "utf8"), symbol, spec);
    } catch {
      return undefined;
    }
  }

  private readFileFromDisk(file: string): string | undefined {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  }

  /** The step the program counter points at, if any remain. */
  current(): ReplayStep | undefined {
    return this.guide?.steps[this.pc.position()];
  }

  // Open the step's file and place the cursor where the human should Tab. Returns
  // the editor, or undefined if the file can't be resolved or the step's landing
  // spot is blocked (already surfaced to the human).
  private async openTarget(step: ReplayStep): Promise<vscode.TextEditor | undefined> {
    const [rel, lineStr] = step.file.split(":");
    const uris = rel ? await vscode.workspace.findFiles(rel) : [];
    if (uris.length === 0) {
      vscode.window.showWarningMessage(
        `Human Replay: step ${step.id} targets "${step.file}", which isn't in the workspace.`,
      );
      return undefined;
    }
    if (uris.length > 1) {
      this.output.appendLine(`[guide] step ${step.id}: "${rel}" matched ${uris.length} files; using the first`);
    }
    const doc = await vscode.workspace.openTextDocument(uris[0]);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = await this.insertionPoint(editor, step, lineStr);
    if (!pos) return undefined;
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.output.appendLine(
      `[guide] step ${step.id}: opened ${vscode.workspace.asRelativePath(doc.uri)} at line ${pos.line + 1}`,
    );
    return editor;
  }

  // Where to land the cursor. Land on the symbol if the target already has it —
  // for modify/delete that's what changes, and for create it means a previous
  // session already started this step (the resume case; a fresh insert would
  // duplicate it). A fresh create then places structurally from live bytes: the
  // sandbox names the container (the file root counts) and the preceding sibling,
  // and the plan lands the symbol relative to where they sit in the target NOW —
  // an authored `:line` goes stale the moment earlier steps move the file, so it
  // never drives create placement. A nested symbol whose container isn't in the
  // target is blocked (undefined) — surfaced, never guessed (invariant 2).
  // Modify/delete keep `:line` as an explicit override, then fall to end-of-file.
  private async insertionPoint(
    editor: vscode.TextEditor,
    step: ReplayStep,
    lineStr: string | undefined,
  ): Promise<vscode.Position | undefined> {
    const doc = editor.document;
    const spec = languageForFile(step.file);

    if (spec) {
      const text = doc.getText();
      const node = findItemByName(parseRoot(text, spec) as unknown as SyntaxNode, text, step.symbol, spec);
      if (node) return doc.positionAt(leadingTriviaStart(text, node.startIndex, spec));

      if (step.action === "create") {
        const sandboxText = this.readSandboxFile(step);
        if (sandboxText !== undefined) {
          const plan = planCreateInsertion(text, sandboxText, step.symbol, spec);
          if (plan.kind === "blocked") {
            vscode.window.showWarningMessage(`Human Replay: step ${step.id} can't place \`${step.symbol}\`: ${plan.reason}.`);
            this.output.appendLine(`[guide] step ${step.id}: placement blocked — ${plan.reason}`);
            return undefined;
          }
          if (plan.kind === "container") {
            this.output.appendLine(`[guide] step ${step.id}: create lands inside \`${plan.container}\``);
            await editor.edit((b) =>
              b.replace(new vscode.Range(doc.positionAt(plan.start), doc.positionAt(plan.end)), plan.scaffold),
            );
            return doc.positionAt(plan.cursorAt);
          }
          // top-level: end-of-file is the symbol's real home
        }
      }
    }

    if (step.action !== "create" && lineStr && /^\d+$/.test(lineStr)) {
      const line = Math.min(Math.max(0, parseInt(lineStr, 10) - 1), Math.max(0, doc.lineCount - 1));
      return new vscode.Position(line, 0);
    }

    // End of file, on a blank line separated from prior content by one empty
    // line. Only a create gets the separator EDIT — for a modify/delete whose
    // symbol wasn't found, EOF is just a neutral place to leave the cursor while
    // the verdict (landed / unresolvable) surfaces; mutating the file first
    // would hand the human a stray blank line to clean up.
    const text = doc.getText();
    if (step.action === "create") {
      const sep = separatorToInsert(text);
      if (sep) {
        await editor.edit((b) => b.insert(doc.positionAt(text.length), sep));
      }
    }
    return doc.positionAt(doc.getText().length);
  }

  // The step's whole sandbox file — the placement side-input for a fresh create.
  private readSandboxFile(step: ReplayStep): string | undefined {
    const root = this.sandboxRoot;
    if (!root) return undefined;
    return this.readFileFromDisk(path.join(root, step.file.split(":")[0]));
  }

  // The bytes a step needs, by symbol. A lean guide carries no fences: `before` is the
  // symbol as it stands in the target workspace (what the human is editing), `after` is
  // the symbol in the sandbox (the desired end state). Embedded fences, if present, win
  // — a self-contained guide still replays. Returns undefined bytes when unresolvable;
  // the caller reports it. Both come from real files, so ground truth holds (invariant 1).
  private resolveStepBytes(editor: vscode.TextEditor, step: ReplayStep, spec: LanguageSpec): { before?: string; after?: string } {
    const before =
      step.action === "create"
        ? undefined
        : step.before ?? this.symbolFrom(editor.document.getText(), step.symbol, spec);
    const after =
      step.action === "delete"
        ? undefined
        : step.after ?? this.readSandboxSymbol(step, spec);
    return { before, after };
  }

  // Extract a named item's exact bytes from `text` by name — fn, struct, enum, const,
  // trait, type alias, static, macro, module (model-free, tree-sitter).
  private symbolFrom(text: string, symbol: string, spec: LanguageSpec): string | undefined {
    return extractSymbol(text, symbol, spec);
  }

  // Read the step's symbol from the sandbox tree (the session's picked sandbox,
  // else config `humanReplay.sandboxRoot`, + the step's file path) — the source
  // of the `after` bytes for a lean guide.
  private readSandboxSymbol(step: ReplayStep, spec: LanguageSpec): string | undefined {
    const root = this.sandboxRoot;
    if (!root) {
      this.output.appendLine(`[guide] step ${step.id}: no sandbox picked and no humanReplay.sandboxRoot set — can't resolve After bytes`);
      return undefined;
    }
    const rel = step.file.split(":")[0];
    const full = path.join(root, rel);
    try {
      return this.symbolFrom(fs.readFileSync(full, "utf8"), step.symbol, spec);
    } catch {
      this.output.appendLine(`[guide] step ${step.id}: failed to read sandbox file ${full}`);
      return undefined;
    }
  }

  // Drop a brand-new file whole from the sandbox — one gesture, no walk. The
  // bytes are the real sandbox file verbatim (invariant 1); saved to disk so the
  // resume derivation and the build see it immediately. A target file that
  // already exists and differs is a genuine conflict: mark the step blocked and
  // let the human decide (hand-merge or skip) — never overwrite.
  private async runCreateFile(index: number, step: ReplayStep): Promise<void> {
    const rel = step.file.split(":")[0];
    const root = this.sandboxRoot;
    if (!root) {
      vscode.window.showWarningMessage(`Human Replay: step ${step.id} needs a sandbox to read ${rel} from — run Start Replay or set humanReplay.sandboxRoot.`);
      return;
    }
    const bytes = this.readFileFromDisk(path.join(root, rel));
    if (bytes === undefined) {
      vscode.window.showWarningMessage(`Human Replay: step ${step.id} can't read ${rel} from the sandbox.`);
      return;
    }
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;
    const targetUri = vscode.Uri.joinPath(ws.uri, rel);
    let existing: string | undefined;
    try {
      existing = Buffer.from(await vscode.workspace.fs.readFile(targetUri)).toString("utf8");
    } catch {
      existing = undefined;
    }

    this.pc.begin(index);
    this.changed();
    if (existing !== undefined && existing !== bytes) {
      this.pc.block();
      this.changed();
      this.output.appendLine(`[guide] step ${step.id}: ${rel} already exists and differs from the sandbox — blocked`);
      vscode.window.showWarningMessage(
        `Human Replay: step ${step.id} — ${rel} already exists and differs from the sandbox. Merge by hand or skip the step.`,
      );
      return;
    }
    if (existing === undefined) {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(targetUri, { ignoreIfExists: true });
      edit.insert(targetUri, new vscode.Position(0, 0), bytes);
      await vscode.workspace.applyEdit(edit);
    }
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await doc.save();
    await vscode.window.showTextDocument(doc, { preview: false });
    this.output.appendLine(`[guide] step ${step.id}: dropped ${rel} whole (${bytes.length} bytes) from the sandbox`);
    if (step.retro.question) {
      void vscode.window.showInformationMessage(`Human Replay — ${step.symbol}: ${step.retro.question}`);
    }
    this.completeCurrent(); // flows into the next step — file drops keep the momentum
  }

  // Land a file's residual line-grain delta — the bits below symbol grain the
  // engine can't address structurally (import edits, module doc headers, items
  // whose home is a convention, files with no grammar at all). Hunks come from
  // a line diff of the live target file against the sandbox file: both sides
  // real bytes (invariant 1), served on diff-replay's decoration surface, one
  // Tab per hunk, collisions surfacing like any other step.
  private async runPatch(index: number, step: ReplayStep): Promise<void> {
    const rel = step.file.split(":")[0];
    const root = this.sandboxRoot;
    if (!root) {
      vscode.window.showWarningMessage(`Human Replay: step ${step.id} needs a sandbox to read ${rel} from — run Start Replay or set humanReplay.sandboxRoot.`);
      return;
    }
    const sandboxText = this.readFileFromDisk(path.join(root, rel));
    if (sandboxText === undefined) {
      vscode.window.showWarningMessage(`Human Replay: step ${step.id} can't read ${rel} from the sandbox.`);
      return;
    }
    const editor = await this.openTarget(step);
    if (!editor) return;
    const targetText = editor.document.getText();
    if (targetText === sandboxText) {
      this.pc.markDone(index);
      this.changed();
      this.output.appendLine(`[guide] step ${step.id}: already matches the sandbox — marked done`);
      const next = this.pc.next();
      if (next < this.steps.length) void this.runStep(next, () => {});
      return;
    }
    this.pc.begin(index);
    this.changed();
    // Line mode anchors on the whole file: park the cursor at file start so the
    // session's anchor offset is 0.
    const top = new vscode.Position(0, 0);
    editor.selection = new vscode.Selection(top, top);
    this.output.appendLine(`[guide] step ${step.id} (${index + 1}/${this.steps.length}) patch ${rel}`);
    await this.orchestrator.startPatch(editor, targetText, sandboxText, step.retro);
  }

  /** Run a step by index: open its file, position the cursor, drive the engine.
   *  Never throws — callers include fire-and-forget auto-advance, so an engine
   *  error marks the step blocked and surfaces instead of vanishing as an
   *  unhandled rejection with the counter stuck in-flight. */
  async runStep(index: number, clearDiagnostics: (doc: vscode.TextDocument) => void): Promise<void> {
    try {
      await this.runStepUnguarded(index, clearDiagnostics);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.output.appendLine(`[guide] step ${this.guide?.steps[index]?.id ?? index} failed: ${msg}`);
      vscode.window.showErrorMessage(`Human Replay: step failed — ${msg}. Marked blocked; skip it or fix the guide.`);
      this.markCurrentBlocked();
    }
  }

  private async runStepUnguarded(index: number, clearDiagnostics: (doc: vscode.TextDocument) => void): Promise<void> {
    const step = this.guide?.steps[index];
    if (!step) {
      vscode.window.showWarningMessage("Human Replay: no such step in the loaded guide.");
      return;
    }
    if (step.action === "create-file") {
      await this.runCreateFile(index, step); // whole-file bytes — no language needed
      return;
    }
    if (step.action === "patch") {
      await this.runPatch(index, step); // line-grain hunks — no language needed
      return;
    }
    const spec = languageForFile(step.file);
    if (!spec) {
      vscode.window.showWarningMessage(
        `Human Replay: step ${step.id} targets ${step.file} — no language support for that extension. Route it to a Manual step or Create File.`,
      );
      this.output.appendLine(`[guide] step ${step.id}: unsupported language for ${step.file}`);
      return;
    }
    const editor = await this.openTarget(step);
    if (!editor) return;
    const { before, after } = this.resolveStepBytes(editor, step, spec);

    // Ground truth beats the click: a step whose outcome is already in the target
    // has nothing to replay. Running it anyway would diff identical bytes into
    // zero ops, instant-complete, and the auto-advance would teleport the human
    // to the next pending step with no visible cause. Say so and mark it done.
    const live = step.action === "create" ? this.symbolFrom(editor.document.getText(), step.symbol, spec) : before;
    if (stepAlreadyLanded(step.action, live, after)) {
      this.pc.markDone(index);
      this.changed();
      this.output.appendLine(`[guide] step ${step.id}: already matches the sandbox — marked done`);
      vscode.window.showInformationMessage(`Human Replay: step ${step.id} already matches the sandbox — marked done.`);
      // Flow into the next step like a completed walk would — a landed verdict
      // shouldn't cost the human an extra click.
      const next = this.pc.next();
      if (next < this.steps.length) void this.runStep(next, clearDiagnostics);
      return;
    }

    // A step can't run without the bytes its action drives. Resolution fails when the
    // sandbox root isn't set, the file isn't there, or the symbol isn't a function the
    // tree-sitter walk finds (the fn-only limit). Surface it; don't crash the engine.
    const need =
      (step.action !== "create" && before === undefined && "Before (target symbol)") ||
      (step.action !== "delete" && after === undefined && "After (sandbox symbol)");
    if (need) {
      vscode.window.showWarningMessage(
        `Human Replay: step ${step.id} can't resolve ${need} for \`${step.symbol}\` in ${step.file}. Check humanReplay.sandboxRoot and that the symbol is a named item (fn, struct, enum, const, trait, ...).`,
      );
      this.output.appendLine(`[guide] step ${step.id}: unresolved bytes — ${need}`);
      return;
    }

    this.pc.begin(index); // the walk advances the counter when it completes, not now
    clearDiagnostics(editor.document);
    this.changed();
    this.output.appendLine(
      `[guide] step ${step.id} (${index + 1}/${this.steps.length}) ${step.action} ${step.symbol}`,
    );

    switch (step.action) {
      case "create": {
        // A create whose symbol is already (partially) in the target is a resumed
        // step — diff-replay the live bytes toward the sandbox instead of walking
        // a duplicate in at end-of-file.
        const existing = this.symbolFrom(editor.document.getText(), step.symbol, spec);
        if (existing !== undefined) {
          this.output.appendLine(`[guide] step ${step.id}: ${step.symbol} already in target — resuming as diff-replay`);
          await this.orchestrator.start(editor, existing, after!, step.retro, true, spec);
          break;
        }
        // The symbol's own first-line indent lands as typed bytes, not ghost
        // bytes — a whitespace-leading ghost can't be Tab-accepted (see
        // splitLeadingPad). Cursor moves past the pad so the walk's base
        // column is the symbol's real column.
        const { pad, rest } = splitLeadingPad(after!);
        if (pad) {
          const at = editor.selection.active;
          await editor.edit((b) => b.insert(at, pad));
          const moved = editor.document.positionAt(editor.document.offsetAt(at) + pad.length);
          editor.selection = new vscode.Selection(moved, moved);
        }
        if (!walkableSource(rest, spec, editor.selection.active.character)) {
          // The walk can only rebuild a bare function — no walk for this language,
          // a non-fn item (struct/const/trait), or leading doc comments/attributes
          // the walk would drop. The whole symbol lands as one block ghost at the
          // parked cursor instead (real sandbox bytes, one Tab). The orchestrator's
          // no-walk guard routes this to the block-swap surface.
          this.output.appendLine(`[guide] step ${step.id}: not walkable — whole-symbol insert`);
          await this.orchestrator.start(editor, "", rest, step.retro, true, spec);
        } else {
          await this.disclosure.start(editor, rest, step.retro, spec);
        }
        break;
      }
      case "modify":
        // In-place: the symbol already lives in the workspace at the parked cursor.
        await this.orchestrator.start(editor, before!, after!, step.retro, true, spec);
        break;
      case "delete":
        // Strike the existing symbol whole and clear to nothing — in-place.
        await this.orchestrator.start(editor, before!, "", step.retro, true, spec);
        break;
    }
  }

  /** Run the next unrun step; tells the human when none remain. */
  async runCurrent(clearDiagnostics: (doc: vscode.TextDocument) => void): Promise<void> {
    const next = this.pc.next();
    if (next >= this.steps.length) {
      vscode.window.showInformationMessage(
        `Human Replay: guide "${this.feature}" — no steps left to run (done or skipped).`,
      );
      return;
    }
    await this.runStep(next, clearDiagnostics);
  }
}
