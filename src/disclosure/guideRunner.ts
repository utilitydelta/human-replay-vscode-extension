import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ReplayGuide, ReplayStep, parseGuide } from "./guide";
import { DisclosureController } from "./controller";
import { ReplayOrchestrator } from "./orchestrator";
import { parseRoot } from "./diff";
import { findItemByName, leadingTriviaStart, walkableSource, SyntaxNode } from "./walk";
import { planCreateInsertion, separatorToInsert, splitLeadingPad } from "./insertion";
import { FileSegment, planFileWalk, resumeIndex, splitTrailing } from "./fileWalk";
import { patchSummary } from "./lineDiff";
import { Retrospective, gates } from "../retrospective/retrospective";
import { PendingGate, RetroGate, gateKey } from "../retrospective/gate";
import { DwellGate } from "./dwell";
import { ProgramCounter, StepStatus } from "./programCounter";
import { extractSymbol, stepAlreadyLanded } from "./resume";
import { LanguageSpec, languageForFile } from "./language";

export { StepStatus };

/** The surface the gate renders through — a QuickPick in the extension, and
 *  nothing at all in a headless test. The runner owns the state machine and
 *  the door; the host only draws and reports picks. */
export interface RetroGateHost {
  /** Show or re-show the pending gate. Called on every run gesture while the
   *  gate stands, so it must be idempotent. */
  show(gate: RetroGate, step: ReplayStep): void;
  /** Tear the picker down without passing the gate (skip, cancel, unload). */
  hide(): void;
}

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
  // Set while the replay waits at a phase boundary — the next phase's title.
  // The status bar renders it as a persistent "click to continue" so the pause
  // survives the toast (which auto-dismisses while the human reviews).
  private pausedBefore: string | undefined;
  // Set while the replay waits before an auto-run Patch step. A whole-file
  // reconcile strikes live bytes — often the human's own mid-replay edits — so
  // momentum never arms one; it pops in as this pause instead, and an explicit
  // run is the ratifying gesture (the human decides, invariant 4).
  private pausedPatch: { index: number; rel: string; detail: string } | undefined;
  // The retrospective gate standing between a completed step and the next one.
  // Set the moment the step's last walk lands and cleared only by a pass (or by
  // skipping the step outright); every run gesture in between re-shows it. This
  // is the door: while it is set, `flowInto` has not been called.
  private pendingGate: { gate: RetroGate; index: number } | undefined;
  // The step whose gate was just passed, waiting on the surface's beat.
  private passedGate: number | undefined;
  // The beat between a step landing and the jump to the next one. Only the
  // momentum path holds: a gated step already stops on its picker with the code
  // still on screen, and a skip or an already-landed step never showed the
  // human anything to read.
  private readonly dwellGate = new DwellGate(
    {
      now: () => Date.now(),
      after: (ms, fn) => setTimeout(fn, ms),
      cancel: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    },
    (next) => {
      this.changed();
      this.output.appendLine(`[dwell] elapsed — flowing into step ${this.guide?.steps[next]?.id ?? next}`);
      void this.runStep(next);
    },
  );
  private gateHost: RetroGateHost | undefined;
  // A create-file step's walk in flight: the segment plan and the position in
  // it. Each segment is one engine run (walk or block ghost); completeCurrent
  // chains the next until the plan is spent, then the step itself completes.
  private fileWalk:
    | { stepId: string; at: number; segments: FileSegment[]; uri: vscode.Uri; spec: LanguageSpec | undefined; retro: Retrospective }
    | undefined;

  private retroSurface: ((retro: Retrospective, index: number) => void) | undefined;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly disclosure: DisclosureController,
    private readonly orchestrator: ReplayOrchestrator,
  ) {}

  setChangeHandler(handler: () => void): void {
    this.onChange = handler;
  }

  /** The picker the gate renders through. Injected so the runner stays testable
   *  and the vscode-coupled surface stays one file (gateSurface.ts). */
  setGateHost(host: RetroGateHost): void {
    this.gateHost = host;
  }

  /** How the ungated step's retrospective reaches the human: one toast with a
   *  "Show step" button. Injected for the same reason as the gate host. */
  setRetrospectiveSurface(surface: (retro: Retrospective, index: number) => void): void {
    this.retroSurface = surface;
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
    if (this.pausedPatch?.index === i) this.pausedPatch = undefined;
    // Skipping the step the gate stands on is the human deciding not to answer.
    // The door opens; nothing else does.
    // Skipping the step the gate stands on is the human deciding not to answer.
    // The step itself is already DONE (the gate parks after the counter marks
    // it), so this is not a skip in the counter's sense: marking it skipped
    // would leave the same index in both `done` and `skipped` and persist that
    // to workspaceState. Open the door and flow, the way a pass does.
    if (this.pendingGate?.index === i) {
      this.clearGate("step skipped");
      this.changed();
      this.flowInto(i);
      return;
    }
    this.pc.skip(i);
    if (wasInFlight) {
      this.disclosure.cancel();
      this.orchestrator.cancelAll();
      this.fileWalk = undefined;
    }
    this.output.appendLine(`[guide] step ${this.guide?.steps[i]?.id ?? i} skipped${wasInFlight ? " (walk cancelled)" : ""}`);
    this.changed();
    if (wasInFlight) this.flowInto(i);
  }

  /** A re-anchored continue collided — mark the in-flight step blocked. */
  markCurrentBlocked(): void {
    this.fileWalk = undefined;
    if (this.pc.block()) this.changed();
  }

  /** Cancel Replay: the caller tears the engines down; clear the counter's
   *  in-flight mark so nothing can complete the cancelled step behind the
   *  human's back. The step keeps its status for a re-run. */
  cancelInFlight(): void {
    this.fileWalk = undefined;
    this.clearGate("replay cancelled");
    if (this.pc.cancelInFlight()) this.changed();
  }

  /** A step's interactive walk finished. Mid file walk, chain the next segment
   *  instead — the step completes only when the plan is spent. Then advance the
   *  counter and flow by the phase policy (flowInto). The auto-advance keeps the
   *  just-set retrospective visible — it passes a no-op clear, unlike a manual
   *  run. No-op when no guide step was in flight. */
  completeCurrent(): void {
    const fw = this.fileWalk;
    if (fw) {
      fw.at++;
      if (fw.at < fw.segments.length) {
        // Fire-and-forget like the auto-advance — but never silently. A segment
        // that dies unlogged strands the step in-flight with no engine armed
        // and Tab falling through to an indent.
        this.runNextSegment().catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          this.output.appendLine(`[guide] step ${fw.stepId}: segment ${fw.at + 1} failed — ${msg}`);
          vscode.window.showErrorMessage(`Human Replay: file-walk segment failed — ${msg}. Marked blocked; re-run or skip the step.`);
          this.markCurrentBlocked();
        });
        return;
      }
      this.fileWalk = undefined;
      // Ground truth beats the session: the walk finishing does not prove the
      // bytes are the sandbox's (a stray keystroke mid-step drifts them). Verify
      // before marking done; a mismatch blocks — re-running the step lands the
      // delta as Tab-gated patch hunks.
      const expected = fw.segments.map((s) => s.sep + s.body).join("");
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === fw.uri.toString());
      if (doc && doc.getText() !== expected) {
        this.output.appendLine(`[guide] step ${fw.stepId}: landed bytes differ from the sandbox — blocked`);
        vscode.window.showWarningMessage(
          `Human Replay: step ${fw.stepId} finished but the file differs from the sandbox. Re-run the step to land the difference as patch hunks, or fix by hand.`,
        );
        if (this.pc.block()) this.changed();
        return;
      }
      void this.saveFileWalkDoc(fw.uri);
    }
    const finished = this.pc.inFlightIndex;
    if (finished === undefined) {
      this.output.appendLine("[guide] engine completion with no step in flight — ignored");
      return;
    }
    // The verify runs BEFORE the counter marks done: "unresolvable" is the one
    // verdict that means the file no longer parses — flowing on from a corrupt
    // file is momentum into a dead end (the live 3.3 session marched two more
    // steps past one). That verdict blocks the step and STOPS the run; kept
    // human edits ("differs") stay a warning and keep flowing. The verify is
    // otherwise a bystander: an exception in it must not strand the flow.
    let verdict = "ok";
    try {
      verdict = this.verifySymbolLanding(finished);
    } catch (e) {
      this.output.appendLine(`[guide] landing verify failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (verdict === "unresolvable") {
      const step = this.guide?.steps[finished];
      this.pc.block();
      this.changed();
      this.output.appendLine(
        `[guide] step ${step?.id ?? finished}: landed \`${step?.symbol}\` is unresolvable in ${step?.file} — run stopped at this step`,
      );
      void vscode.commands.executeCommand("humanReplay.guideSteps.focus");
      void vscode.window.showWarningMessage(
        `Human Replay: step ${step?.id} landed, but \`${step?.symbol}\` can't be parsed back out of ${step?.file} — the file is likely broken. ` +
          `The run is stopped here: fix the file (undo, or finish by hand), then re-run the step.`,
      );
      return;
    }
    this.pc.complete();
    this.changed();
    this.output.appendLine(`[guide] step ${this.guide?.steps[finished]?.id ?? finished} complete`);
    // Persist what landed: symbol steps edit the buffer and nothing else
    // saves it, so disk lags the session — resume derivation and any
    // out-of-band read (build, forensics) see stale bytes until a manual
    // Ctrl+S. The file walk already saves; match it.
    this.saveStepDoc(finished).catch((e) => {
      this.output.appendLine(`[guide] step save failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    this.gateOrFlow(finished);
  }

  // The one place a walk finishing turns into the next step — and so the one
  // place the gate can stand. The other `flowInto` callers (skip, resume,
  // already-landed, already-matching) are not walks finishing, so they bypass
  // the gate by construction rather than by a flag.
  private gateOrFlow(finished: number): void {
    const step = this.guide?.steps[finished];
    if (!step) {
      this.flowInto(finished);
      return;
    }
    const retro = step.retro;
    if (retro.choices.length === 3 && !gates(retro)) {
      // Parsed an answer key but refused to gate: the only way here is a weak
      // or wired-off question. Say which — a silent ungated step reads as a bug
      // to whoever wrote the distractors.
      const why =
        retro.question.trim() === ""
          ? "there is no question to ask"
          : /^\s*none\b/i.test(retro.question)
            ? "the question is wired off (`none`)"
            : "the question is weak (a confidence probe on the guide's author, not the human)";
      this.output.appendLine(`[gate] step ${step.id} not gated — ${why}`);
    }
    if (!gates(retro)) {
      this.retroSurface?.(retro, finished);
      // The only flow that dwells. A gated step does not need one: its picker
      // already stops the replay with the landed code still on screen behind
      // it. This is the run of ungated steps between two gates, which is where
      // momentum used to scroll the bytes away before they were read.
      this.flowInto(finished, true);
      return;
    }
    this.armGate(finished, undefined);
  }

  // Stand the gate up (fresh, or restored from a reload). Nothing flows until
  // the human picks the answer.
  private armGate(index: number, pending: PendingGate | undefined): void {
    const step = this.guide?.steps[index];
    if (!step) return;
    const lockoutMs =
      Math.max(0, vscode.workspace.getConfiguration("humanReplay").get<number>("gateLockoutSeconds", 5)) * 1000;
    const opts = {
      stepId: step.id,
      question: step.retro.question,
      choices: step.retro.choices,
      lockoutMs,
      now: () => Date.now(),
    };
    const gate = pending ? RetroGate.restore(pending, opts) : new RetroGate(opts);
    this.pendingGate = { gate, index };
    this.changed();
    this.output.appendLine(
      `[gate] step ${step.id} shown — ${gate.order.length} choices${pending ? `, restored with ${gate.wrongCount} wrong pick(s)` : ""}`,
    );
    this.gateHost?.show(gate, step);
  }

  /** The gate standing between the replay and the next step, for the status bar
   *  and the `humanReplay.gateActive` context key. */
  get gateStep(): ReplayStep | undefined {
    const p = this.pendingGate;
    return p ? this.guide?.steps[p.index] : undefined;
  }

  /** Any run gesture while the gate stands re-shows it instead of running —
   *  status bar, tree click, Run Next Step, Tab. Returns true when it took the
   *  gesture, so the caller does nothing else. */
  reshowGate(): boolean {
    const p = this.pendingGate;
    if (!p) return false;
    const step = this.guide?.steps[p.index];
    if (!step) return false;
    // Ground truth outranks the gate. A human who Esc'd the question, undid the
    // bytes and came back to re-run the step is not dodging it — the gate is
    // asking about code that is no longer there. Drop it, put the step back to
    // pending, and let the run through. Same verdict the resume path derives on
    // a fresh Start Replay; the difference was that nothing re-read the files
    // mid-session.
    if (this.stepStillLanded(p.index) === false) {
      this.clearGate("the bytes it gated are gone from the target");
      this.pc.markPending(p.index);
      this.changed();
      this.output.appendLine(`[guide] step ${step.id}: rolled back under the gate — pending again, re-running`);
      return false;
    }
    this.output.appendLine(`[gate] step ${step.id} re-shown (run gesture while the gate stands)`);
    this.gateHost?.show(p.gate, step);
    return true;
  }

  /** The human picked choice `index` in the gate's shuffled order. Returns the
   *  machine's verdict so the surface can mark the item; a pass flows into the
   *  next step exactly as a walk finishing used to. */
  pickGate(index: number): ReturnType<RetroGate["pick"]> | undefined {
    const p = this.pendingGate;
    if (!p) return undefined;
    const step = this.guide?.steps[p.index];
    const verdict = p.gate.pick(index);
    const id = step?.id ?? p.index;
    if (verdict.kind === "wrong") {
      this.output.appendLine(
        `[gate] step ${id} wrong pick "${p.gate.order[index]?.text}" — locked for ${Math.round(p.gate.lockoutRemainingMs / 1000)}s`,
      );
      this.changed();
    } else if (verdict.kind === "ignored") {
      this.output.appendLine(`[gate] step ${id} accept ignored (${verdict.reason})`);
    } else {
      this.output.appendLine(
        `[gate] step ${id} passed after ${verdict.wrongCount} wrong in ${verdict.elapsedMs}ms`,
      );
      this.pendingGate = undefined;
      // The door is open, but nothing moves yet. The surface holds the check
      // mark for a beat and calls flowAfterGate when it is down: opening the
      // next step's editor UNDER a QuickPick that has ignoreFocusOut set parks
      // a cursor and triggers a ghost on an editor that does not have focus,
      // which is how this repo earned its stray-indent scars.
      this.passedGate = p.index;
      this.changed();
      if (!this.gateHost) this.flowAfterGate(); // headless: no beat to wait for
    }
    return verdict;
  }

  // Hold in front of the next step so the bytes that just landed stay on screen
  // long enough to read. Tab cuts it short, Esc parks it indefinitely.
  private holdBeforeNext(next: number): boolean {
    // The dwell exists because the replay TAKES YOU AWAY from what you just
    // read. When it doesn't — the next step is a method inside the impl block
    // that just landed, or the symbol below it, still on screen — there is
    // nothing to hold and the hold is pure friction.
    if (this.nextStepIsOnScreen(next)) {
      this.output.appendLine(`[dwell] no hold — step ${this.guide?.steps[next]?.id ?? next} is already on screen`);
      return false;
    }
    const seconds = vscode.workspace.getConfiguration("humanReplay").get<number>("dwellSeconds", 3);
    if (!this.dwellGate.hold(next, Math.max(0, seconds) * 1000)) return false;
    this.changed();
    this.output.appendLine(
      `[dwell] holding ${seconds}s on what landed before step ${this.guide?.steps[next]?.id ?? next} — Tab to move on, Esc to stay`,
    );
    return true;
  }

  // Will running `next` move the human's eyes? Different file, yes. Same file,
  // only if its symbol sits outside what the editor is showing right now.
  //
  // The unknown case — same file, symbol not in the target yet — reads as "on
  // screen", i.e. no hold. That is a fresh create, and a create lands either
  // inside the container just built or at the end of the file the human is
  // already looking at. Guessing wrong here costs a pause, not a byte.
  private nextStepIsOnScreen(next: number): boolean {
    const step = this.guide?.steps[next];
    if (!step) return false;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return false;
    const rel = step.file.split(":")[0];
    if (!rel || !editor.document.uri.fsPath.endsWith(rel)) return false;
    const spec = languageForFile(rel);
    if (!spec) return true;
    try {
      const text = editor.document.getText();
      const node = findItemByName(parseRoot(text, spec), text, step.symbol, spec);
      if (!node) return true;
      const line = editor.document.positionAt(node.startIndex).line;
      return editor.visibleRanges.some((r) => line >= r.start.line && line <= r.end.line);
    } catch {
      return true;
    }
  }

  /** What the status bar renders while the replay is holding or parked. */
  get dwellInfo(): { mode: "holding" | "parked"; next: number; remainingMs: number; stepId: string } | undefined {
    const info = this.dwellGate.info;
    if (!info) return undefined;
    return { ...info, stepId: this.guide?.steps[info.next]?.id ?? String(info.next) };
  }

  /** Esc during the hold: stop the clock and stay on this code. The replay is
   *  still armed, so Tab continues to mean "continue" rather than "indent". */
  parkDwell(): boolean {
    if (!this.dwellGate.park()) return false;
    this.changed();
    this.output.appendLine(`[dwell] parked — the replay waits here until you ask for the next step`);
    return true;
  }

  /** The check mark is down. Flow into the next step exactly as a walk
   *  finishing used to. Idempotent: only the first call after a pass flows. */
  flowAfterGate(): void {
    const from = this.passedGate;
    if (from === undefined) return;
    this.passedGate = undefined;
    this.flowInto(from);
  }

  /** Esc: the picker goes away, the gate does not. The status bar keeps saying
   *  so and the next run gesture brings it back with the same order. */
  dismissGate(): void {
    const p = this.pendingGate;
    if (!p) return;
    this.output.appendLine(`[gate] step ${this.guide?.steps[p.index]?.id ?? p.index} dismissed — re-arms on the next run gesture`);
    this.changed();
  }

  /** Drop the gate entirely: the step was skipped, the session cancelled, or the
   *  guide unloaded. The context key goes with it. */
  private clearGate(reason: string): void {
    this.passedGate = undefined;
    this.dwellGate.clear();
    if (!this.pendingGate) return;
    this.output.appendLine(`[gate] step ${this.guide?.steps[this.pendingGate.index]?.id ?? this.pendingGate.index} gate dropped — ${reason}`);
    this.pendingGate = undefined;
    this.gateHost?.hide();
    this.changed();
  }

  private async saveStepDoc(index: number): Promise<void> {
    const step = this.guide?.steps[index];
    if (!step) return;
    const rel = step.file.split(":")[0];
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith(rel));
    if (doc?.isDirty) await doc.save();
  }

  // Ground truth beats the session for symbol steps too: a walk completing
  // proves gestures happened, not that the bytes match the sandbox (a recovery
  // cascade once nested siblings doll-style and still read as done).
  // "differs" is a WARNING, not a block — Skip This Hunk and kept edits make
  // honest, human-ratified divergence; a reload reads the step as pending and
  // re-running offers the remaining delta. "unresolvable" is different in
  // kind: the symbol can't be parsed back out at all, the one signal the file
  // is corrupt — the caller stops the run on it (work item 2).
  private verifySymbolLanding(index: number): "ok" | "differs" | "unresolvable" {
    const step = this.guide?.steps[index];
    if (!step || (step.action !== "create" && step.action !== "modify")) return "ok";
    const rel = step.file.split(":")[0];
    const spec = languageForFile(rel);
    if (!spec) return "ok";
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith(rel));
    if (!doc) return "ok";
    const after = step.after ?? this.readSandboxSymbol(step, spec);
    if (after === undefined) return "ok"; // nothing to verify against — no verdict
    const live = this.symbolFrom(doc.getText(), step.symbol, spec);
    if (live === after) return "ok";
    if (live === undefined) return "unresolvable"; // the caller stops and says why
    this.output.appendLine(
      `[guide] step ${step.id}: landed \`${step.symbol}\` differs from the sandbox — done this session, pending on reload`,
    );
    void vscode.window.showWarningMessage(
      `Human Replay: step ${step.id} finished but \`${step.symbol}\` differs from the sandbox (your kept edits, or drift). Re-run the step to see the delta.`,
    );
    return "differs";
  }

  // The one flow policy after a step resolves (completed, landed, or skipped).
  // Within a phase, momentum: run the next step so the human tabs across step
  // boundaries without clicking. At a phase boundary, STOP — the human reads
  // the invariants and the retrospective, reviews what landed, and continues
  // with an explicit gesture (the message button, the status bar, the tree).
  // At scale a phase is a chapter, not a speed bump (feedback.md #2).
  private flowInto(fromIndex: number, dwell = false): void {
    const next = this.pc.next();
    if (next >= this.steps.length) {
      if (this.pc.isComplete) {
        this.output.appendLine(`[guide] guide "${this.feature}" complete`);
        void vscode.window.showInformationMessage(`Human Replay: guide "${this.feature}" complete — every step done or skipped.`);
      }
      return;
    }
    const from = this.guide?.steps[fromIndex];
    const to = this.guide?.steps[next];
    if (from && to && from.phase !== to.phase) {
      const done = from.phase ?? "steps";
      this.output.appendLine(`[guide] ${done} complete — paused before ${to.phase ?? "the next steps"}`);
      // The pause needs surfaces that OUTLIVE a toast: the status bar flips to
      // a persistent "click to continue" (via pausedPhase + changed), and the
      // Replay Guide panel reveals itself — it is the control surface for the
      // stop. The toast stays as the immediate narration.
      this.pausedBefore = to.phase ?? "the next steps";
      this.changed();
      void vscode.commands.executeCommand("humanReplay.guideSteps.focus");
      void vscode.window
        .showInformationMessage(`Human Replay: ${done} complete. Review what landed, then continue when ready.`, "Continue replay")
        .then((choice) => {
          if (choice !== "Continue replay") return;
          const at = this.pc.next();
          if (at < this.steps.length) void this.runStep(at);
        });
      return;
    }
    if (to?.action === "patch") {
      this.pauseBeforePatch(next, to);
      return;
    }
    // The one place momentum runs free, and so the one place worth holding.
    // Everything above this line is already a stop the human has to ratify.
    if (dwell && this.holdBeforeNext(next)) return;
    this.output.appendLine(`[guide] flowing into step ${to?.id ?? next}`);
    void this.runStep(next);
  }

  // Momentum stops at a Patch step the way it stops at a phase boundary. Its
  // hunks strike whatever the live file holds that the sandbox doesn't — which
  // includes the human's own hacks — and a whole-file-red strike popping in
  // uninvited reads as data loss. Say up front what the patch would strike
  // (same lineDiffSteps the session will serve, so the numbers are the ground
  // truth) and wait for an explicit run. A patch with nothing to reconcile
  // skips the ceremony: running it just marks the step done and flows on.
  private pauseBeforePatch(index: number, step: ReplayStep): void {
    const rel = step.file.split(":")[0];
    const live = this.readLiveFile(rel);
    const sandbox = this.readSandboxFile(step);
    if (live !== undefined && sandbox !== undefined && live === sandbox) {
      void this.runStep(index);
      return;
    }
    const summary = live !== undefined && sandbox !== undefined ? patchSummary(live, sandbox) : undefined;
    const detail = summary
      ? `${summary.hunks} hunk(s), striking ${summary.struckLines} live line(s)`
      : "live or sandbox bytes unreadable — running it will surface why";
    this.pausedPatch = { index, rel, detail };
    this.changed();
    this.output.appendLine(`[guide] paused before patch step ${step.id}: ${rel} — ${detail}`);
    void vscode.window
      .showInformationMessage(
        `Human Replay: next is a patch of ${rel} — ${detail}. Struck lines can include your own edits; Shift+Esc keeps a hunk's live bytes.`,
        "Review hunks",
        "Skip step",
      )
      .then((choice) => {
        if (choice === "Review hunks") void this.runStep(index);
        else if (choice === "Skip step") this.skip(index);
      });
  }

  // The step's file as the human sees it: the open (possibly dirty) buffer
  // beats disk — symbol steps save late, and the pause summary must count the
  // bytes the hunks will actually strike.
  private readLiveFile(rel: string): string | undefined {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith(rel));
    if (open) return open.getText();
    const ws = vscode.workspace.workspaceFolders?.[0];
    return ws ? this.readFileFromDisk(path.join(ws.uri.fsPath, rel)) : undefined;
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

  /** The next phase's title while the replay waits at a phase boundary. */
  get pausedPhase(): string | undefined {
    return this.pausedBefore;
  }

  /** What the pending Patch step would strike, while the replay waits for the
   *  human to enter it. */
  get pausedPatchInfo(): { rel: string; detail: string } | undefined {
    return this.pausedPatch;
  }

  /** Re-derive every step's status from the bytes on disk — the gesture after
   *  a rollback. Done marks are recomputed from ground truth (a reverted
   *  symbol falls back to pending); skips survive (human intent bytes can't
   *  derive); a phase pause clears. The caller tears down any in-flight
   *  engines first. */
  resync(workspaceRoot: string): void {
    const skipped = this.pc.snapshot().skipped;
    this.pc.reset(this.steps.length);
    for (const i of skipped) this.pc.skip(i);
    this.pausedBefore = undefined;
    this.pausedPatch = undefined;
    this.clearGate("resynced from files");
    const landed = this.deriveLanded(workspaceRoot);
    this.changed();
    this.output.appendLine(`[guide] resynced from files — ${landed} step(s) read as landed, ${skipped.length} skip(s) kept`);
  }

  /** End the replay session: unload the guide, drop the sandbox pin, reset the
   *  counter. The panel and status bar key off `loaded`, so they retire with
   *  it. Done/skipped marks live in workspaceState and re-derive from bytes on
   *  the next load — ending a session never loses position. */
  unload(): void {
    this.fileWalk = undefined;
    this.clearGate("replay session ended");
    this.pausedBefore = undefined;
    this.pausedPatch = undefined;
    this.guide = undefined;
    this.sessionSandboxRoot = undefined;
    this.pc.reset(0);
    this.changed();
    this.output.appendLine("[guide] replay session ended — guide unloaded");
  }

  load(md: string): ReplayGuide {
    const guide = parseGuide(md); // throws loud on a malformed guide (invariant 3)
    // A gate standing over the OLD guide indexes steps that no longer exist.
    // The saved snapshot re-arms it by step id if this is the same guide.
    this.clearGate("a different guide loaded");
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

  /** The persistable position (done + skipped + a standing gate) for
   *  workspaceState. The gate rides beside the counter because a reload must
   *  re-arm it even though the bytes read the step as done. */
  snapshot(): { done: number[]; skipped: number[]; gate?: PendingGate } {
    return { ...this.pc.snapshot(), gate: this.pendingGate?.gate.serialize() };
  }

  /** Merge a persisted position back in (union with live progress). A saved
   *  gate re-arms against the step id it names — the guide is canonical, so the
   *  choices and the shuffle rebuild from it rather than from the snapshot. */
  restore(s: { done?: number[]; skipped?: number[]; gate?: PendingGate }): void {
    this.pc.restore(s);
    if (s.gate) {
      const index = this.steps.findIndex((step) => step.id === s.gate!.stepId);
      if (index < 0 || !gates(this.steps[index].retro)) {
        this.output.appendLine(`[gate] saved gate for step ${s.gate.stepId} no longer gates — dropped`);
      } else if (s.gate.key !== gateKey(this.steps[index].retro.question, this.steps[index].retro.choices)) {
        // The guide was edited under a standing gate. The saved wrong picks are
        // indices into a shuffle the old question seeded, so restoring them
        // would eliminate whichever choice now sits in those slots — the answer
        // included. Re-arm from the guide instead; the guide is canonical.
        this.output.appendLine(`[gate] step ${s.gate.stepId}: answer key changed under the saved gate — re-armed fresh`);
        this.armGate(index, undefined);
      } else {
        this.armGate(index, s.gate);
      }
    }
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
      // A skeleton (fenced) create-file is landed once the target begins with
      // it — later symbol steps grow the file past the skeleton.
      if (step.action === "create-file" && step.after !== undefined) {
        if (target !== undefined && target.startsWith(step.after)) {
          this.pc.markDone(i);
          landed++;
          this.output.appendLine(`[guide] step ${step.id} already landed (target carries the skeleton) — marked done`);
        }
        return;
      }
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
    await this.parkCursor(doc, pos);
    this.output.appendLine(
      `[guide] step ${step.id}: opened ${vscode.workspace.asRelativePath(doc.uri)} at line ${pos.line + 1}`,
    );
    return editor;
  }

  // Park the cursor through showTextDocument so the jump lands in VS Code's
  // navigation history — Back must rewind a replay teleport (feedback.md #3).
  // A bare `editor.selection =` writes no history entry. Step-level jumps only;
  // engine-internal hunk-to-hunk moves stay out or twenty Tabs would mean
  // twenty history entries.
  private async parkCursor(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.TextEditor> {
    return vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(pos, pos) });
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
  // Is this step's outcome still in the target? The same comparison
  // `deriveLanded` makes on load, for one step, against the live buffer rather
  // than only disk. `undefined` means no verdict (no language, no sandbox, an
  // unreadable file) — the caller must not treat that as "gone".
  private stepStillLanded(index: number): boolean | undefined {
    const step = this.guide?.steps[index];
    if (!step) return undefined;
    const rel = step.file.split(":")[0];
    const wholeFile = step.action === "create-file" || step.action === "patch";
    const spec = languageForFile(rel);
    if (!wholeFile && !spec) return undefined;
    const live = this.readLiveFile(rel);
    if (live === undefined) return step.action === "delete" ? undefined : false;
    const target = wholeFile ? live : this.symbolFrom(live, step.symbol, spec!);
    // A skeleton create-file is landed while the target still begins with it —
    // later symbol steps grow the file past the skeleton.
    if (step.action === "create-file" && step.after !== undefined) {
      return target !== undefined && target.startsWith(step.after);
    }
    const after = wholeFile ? this.readSandboxFile(step) : (step.after ?? this.readSandboxSymbol(step, spec!));
    if (after === undefined && step.action !== "delete") return undefined;
    return stepAlreadyLanded(step.action, target, after);
  }

  /** Open the code a step landed and put the cursor on its symbol — the gate's
   *  "open code" button. Parse-located, not text-searched: an authored `:line`
   *  goes stale the moment an earlier step moves the file, so it is only the
   *  fallback for a file no language here parses. */
  async revealStepCode(index: number): Promise<void> {
    const step = this.guide?.steps[index];
    if (!step) return;
    const [rel, lineStr] = step.file.split(":");
    const uris = rel ? await vscode.workspace.findFiles(rel) : [];
    if (uris.length === 0) {
      vscode.window.showWarningMessage(`Human Replay: "${step.file}" isn't in the workspace.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uris[0]);
    const spec = languageForFile(rel);
    let pos = new vscode.Position(lineStr ? Math.max(0, Number(lineStr) - 1) : 0, 0);
    if (spec) {
      try {
        const text = doc.getText();
        const node = findItemByName(parseRoot(text, spec), text, step.symbol, spec);
        if (node) pos = doc.positionAt(leadingTriviaStart(text, node.startIndex, spec));
      } catch (e) {
        this.output.appendLine(`[gate] open code: ${step.symbol} not locatable — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await this.parkCursor(doc, pos);
    this.output.appendLine(`[gate] step ${step.id} open code — ${rel}:${pos.line + 1}`);
  }

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

  // Disclose a brand-new file segment by segment — the file walk. The plan cuts
  // the bytes into blank-line groups (fileWalk.ts, byte-exact); each segment
  // lands as one gesture: the descend-and-fill walk for a bare function, the
  // block ghost otherwise, a single patch hunk for a file with no grammar.
  //
  // The bytes are the whole sandbox file — or, when the step embeds an After
  // fence, that fence: the file's SKELETON (header, usings, frame), with the
  // rest of the file arriving as symbol create steps that carry their own Why
  // and retrospective. Fences win over file resolution, like every other step.
  // Either way the bytes are real sandbox bytes (invariant 1). A target file
  // that already exists resumes at a segment boundary when it is a prefix;
  // anything else is a genuine conflict — blocked, never overwritten
  // (invariant 2).
  private async runCreateFile(index: number, step: ReplayStep, wasMidFileWalk = false): Promise<void> {
    const rel = step.file.split(":")[0];
    let bytes = step.after;
    if (bytes === undefined) {
      const root = this.sandboxRoot;
      if (!root) {
        vscode.window.showWarningMessage(`Human Replay: step ${step.id} needs a sandbox to read ${rel} from — run Start Replay or set humanReplay.sandboxRoot.`);
        return;
      }
      bytes = this.readFileFromDisk(path.join(root, rel));
    }
    if (bytes === undefined) {
      vscode.window.showWarningMessage(`Human Replay: step ${step.id} can't read ${rel} from the sandbox.`);
      return;
    }
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;
    const targetUri = vscode.Uri.joinPath(ws.uri, rel);
    // Read the OPEN buffer first: mid-walk the file is dirty, and disk is stale
    // until the walk's final save. But an editor tab can outlive its file (the
    // human deleted it on disk) — those bytes are a ghost, not ground truth,
    // and marked a deleted file's step done while the next step failed on the
    // missing file. No disk file → fresh create, whatever zombie tabs hold.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === targetUri.toString());
    let existing = open?.getText();
    if (existing === undefined) {
      try {
        existing = Buffer.from(await vscode.workspace.fs.readFile(targetUri)).toString("utf8");
      } catch {
        existing = undefined;
      }
    } else {
      try {
        await vscode.workspace.fs.stat(targetUri);
      } catch {
        this.output.appendLine(`[guide] step ${step.id}: ${rel} is open in an editor but gone from disk — treating as a fresh create`);
        existing = undefined;
      }
    }

    // A blocked create-file the human explicitly re-runs is a ratified resume:
    // the target holds our drifted partial build, and the patch surface lands
    // the remainder one Tab-gated hunk at a time. Read the status before
    // begin() clears the block mark.
    const wasBlocked = this.pc.status(index) === "blocked";
    this.pc.begin(index);
    this.changed();

    // A skeleton (fenced) create-file is landed once the target BEGINS with it —
    // the symbol steps that follow grow the file past the skeleton, and their
    // growth must not un-land this step. A whole-file step stays byte-equality.
    const landed =
      existing !== undefined && (step.after !== undefined ? existing.startsWith(bytes) : existing === bytes);
    if (landed || bytes === "") {
      // Already landed, or an empty sandbox file — nothing to disclose. Create
      // the empty file if needed, mark done, flow.
      if (existing === undefined) {
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(targetUri, { ignoreIfExists: true });
        await vscode.workspace.applyEdit(edit);
      }
      this.pc.markDone(index);
      this.changed();
      await this.saveFileWalkDoc(targetUri);
      this.output.appendLine(`[guide] step ${step.id}: ${rel} ${landed ? "already carries this step's bytes" : "is empty in the sandbox"} — marked done`);
      this.flowInto(index);
      return;
    }

    const spec = languageForFile(rel);
    const segments = planFileWalk(bytes, spec);
    const at = existing === undefined ? 0 : resumeIndex(segments, existing);
    if (at === undefined || at >= segments.length) {
      if ((wasMidFileWalk || wasBlocked) && existing !== undefined) {
        // Re-armed mid-segment or re-run after a block: the buffer holds OUR
        // drifted build, not a foreign file. The patch surface lands the
        // remainder deterministically, one hunk per Tab.
        this.output.appendLine(`[guide] step ${step.id}: resuming ${rel} as a patch (${wasBlocked ? "was blocked" : "re-armed mid-segment"})`);
        const editor = await this.parkCursor(await vscode.workspace.openTextDocument(targetUri), new vscode.Position(0, 0));
        await this.orchestrator.startPatch(editor, existing, bytes, step.retro);
        return;
      }
      // A foreign file at the step's path is a genuine conflict — the human
      // decides (hand-merge or skip), never an overwrite.
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
      await vscode.workspace.applyEdit(edit);
    }
    this.fileWalk = { stepId: step.id, at, segments, uri: targetUri, spec, retro: step.retro };
    this.output.appendLine(
      `[guide] step ${step.id}: file walk of ${rel} — ${segments.length} segment(s)${at > 0 ? `, resuming at ${at + 1}` : ""}`,
    );
    await this.runNextSegment();
  }

  // Land the file walk's current segment: park at end-of-file (the walk builds
  // strictly downward), type the separator and the first-line pad as real bytes
  // (a whitespace-leading ghost can't be Tab-accepted), then hand the content to
  // the engine that fits it. Completion flows back through completeCurrent.
  private async runNextSegment(): Promise<void> {
    const fw = this.fileWalk;
    if (!fw) return;
    const seg = fw.segments[fw.at];
    const doc = await vscode.workspace.openTextDocument(fw.uri);
    // The step's retrospective gates the whole file, so it rides the last segment.
    const retro = fw.at === fw.segments.length - 1 ? fw.retro : undefined;
    const first = seg.body.split("\n")[0];
    this.output.appendLine(
      `[guide] step ${fw.stepId}: segment ${fw.at + 1}/${fw.segments.length} — ${first.slice(0, 60)}`,
    );

    if (!fw.spec) {
      // No grammar (config files, lockfiles): the patch surface lands the whole
      // segment as one hunk — deterministic, parse-free, one Tab.
      const text = doc.getText();
      const editor = await this.parkCursor(doc, new vscode.Position(0, 0));
      await this.orchestrator.startPatch(editor, text, text + seg.sep + seg.body, retro);
      return;
    }

    const { pad, rest } = splitLeadingPad(seg.body);
    // A walk rebuilds its node's bytes and nothing more, so the segment's
    // trailing whitespace (the file's final newline) is typed with the lead —
    // inserted at end-of-file with the cursor parked ahead of it.
    const { content, tail } = splitTrailing(rest);
    const walkable = content !== "" && walkableSource(content, fw.spec);
    const lead = seg.sep + pad;
    const typed = walkable ? lead + tail : lead;
    if (typed) {
      const opened = await vscode.window.showTextDocument(doc, { preview: false });
      const end = doc.positionAt(doc.getText().length);
      const applied = await opened.edit((b) => b.insert(end, typed));
      if (!applied) throw new Error(`separator edit rejected on segment ${fw.at + 1}`);
    }
    const cursor = doc.positionAt(doc.getText().length - (walkable ? tail.length : 0));
    const editor = await this.parkCursor(doc, cursor);

    if (walkable) {
      await this.disclosure.start(editor, content, retro, fw.spec);
    } else {
      // Non-walkable segment (imports, an interface, a comment block): one
      // block ghost, real sandbox bytes, one Tab — the orchestrator's no-walk
      // guard routes it.
      await this.orchestrator.start(editor, "", rest, retro, true, fw.spec);
    }
  }

  // Persist the finished file so the resume derivation and the build see it.
  private async saveFileWalkDoc(uri: vscode.Uri): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await doc.save();
    } catch {
      // The buffer may already be gone (window closed mid-save) — nothing to do.
    }
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
      this.flowInto(index);
      return;
    }
    this.pc.begin(index);
    this.changed();
    // Line mode anchors on the whole file: park the cursor at file start so the
    // session's anchor offset is 0.
    await this.parkCursor(editor.document, new vscode.Position(0, 0));
    this.output.appendLine(`[guide] step ${step.id} (${index + 1}/${this.steps.length}) patch ${rel}`);
    await this.orchestrator.startPatch(editor, targetText, sandboxText, step.retro);
  }

  /** Run a step by index: open its file, position the cursor, drive the engine.
   *  Never throws — callers include fire-and-forget auto-advance, so an engine
   *  error marks the step blocked and surfaces instead of vanishing as an
   *  unhandled rejection with the counter stuck in-flight. */
  async runStep(index: number): Promise<void> {
    // The gate holds the door against MOMENTUM, not against navigation. A tree
    // click names a step: name the gated one and the question is what you asked
    // for; name another and you have decided where to go, which outranks the
    // gate (invariant 4, the human decides). The continue gestures — Tab, the
    // status bar, Run Next Step — still route through `runCurrent`, which
    // re-shows, because "move on" is exactly what the gate stands in front of.
    const standing = this.pendingGate;
    if (standing && standing.index !== index) {
      const gated = this.guide?.steps[standing.index];
      this.clearGate(`step ${this.guide?.steps[index]?.id ?? index} was run instead — ${gated?.id ?? standing.index} left unanswered`);
    } else if (this.reshowGate()) {
      return;
    }
    // A run gesture during the hold is "I have read it, move" — take the dwell
    // so its timer can never fire a second run at the same step.
    if (this.dwellGate.info) {
      const held = this.dwellGate.take();
      this.changed();
      this.output.appendLine(`[dwell] cut short by a run gesture — step ${this.guide?.steps[held ?? index]?.id ?? index}`);
    }
    try {
      await this.runStepUnguarded(index);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.output.appendLine(`[guide] step ${this.guide?.steps[index]?.id ?? index} failed: ${msg}`);
      vscode.window.showErrorMessage(`Human Replay: step failed — ${msg}. Marked blocked; skip it or fix the guide.`);
      this.markCurrentBlocked();
    }
  }

  private async runStepUnguarded(index: number): Promise<void> {
    const step = this.guide?.steps[index];
    if (!step) {
      vscode.window.showWarningMessage("Human Replay: no such step in the loaded guide.");
      return;
    }
    if (this.pausedBefore !== undefined) {
      this.pausedBefore = undefined; // any run is the continue gesture
      this.changed();
    }
    if (this.pausedPatch !== undefined) {
      this.pausedPatch = undefined; // any run ratifies the patch pause too
      this.changed();
    }
    // A manual run while a step is mid-flight replaces it — tear the live
    // engines down first so two walks never fight over one buffer. Clicking the
    // in-flight step itself is the re-arm gesture: park the cursor back on the
    // work and show the ghost again (feedback.md #4).
    const wasMidFileWalk = this.pc.inFlightIndex === index && this.fileWalk !== undefined;
    if (this.pc.inFlightIndex !== undefined) {
      this.disclosure.cancel();
      this.orchestrator.cancelAll();
      this.fileWalk = undefined;
    }
    // A cancel at zero accepted steps restores a rewrite-cleared symbol — wait
    // for that edit, or this run resolves its Before bytes from the hole (the
    // 3.3 dead end: "unresolved bytes — Before (target symbol)"). Awaited
    // UNCONDITIONALLY: an Esc (cancelDisclosure) or a skip already cleared
    // in-flight, but its restore edit may still be airborne.
    await this.orchestrator.settleRestore();
    if (step.action === "create-file") {
      await this.runCreateFile(index, step, wasMidFileWalk);
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
      // shouldn't cost the human an extra click. Same phase policy as any flow.
      this.flowInto(index);
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
        if (!walkableSource(rest, spec)) {
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
  async runCurrent(): Promise<void> {
    if (this.reshowGate()) return;
    const next = this.pc.next();
    if (next >= this.steps.length) {
      vscode.window.showInformationMessage(
        `Human Replay: guide "${this.feature}" — no steps left to run (done or skipped).`,
      );
      return;
    }
    await this.runStep(next);
  }
}
