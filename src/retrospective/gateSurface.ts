import * as vscode from "vscode";
import { GateVerdict, RetroGate } from "./gate";
import { ReplayStep } from "../disclosure/guide";
import { RetroGateHost } from "../disclosure/guideRunner";

// The gate's picker. VS Code has no custom modal — the only modal is
// showInformationMessage, whose buttons cannot be styled, disabled or updated in
// place — so the surface is a QuickPick: native, keyboard first, no HTML, no
// editor column stolen.
//
// The concessions, all real and all checked against what VS Code actually does:
//
//   - A coloured item icon is tree-only. "Wrong" is a `$(error)` codicon and the
//     Why on the item's detail line, not red.
//   - `enabled = false` locks the mouse only; Enter still fires accept. So the
//     lockout lives in the STATE MACHINE, which rejects accepts, and the picker
//     merely shows it.
//   - Esc always dismisses. That is fine: the gate is in the runner, not here,
//     so Esc hides the picker and the next run gesture brings it back.
//   - Every row truncates with an ellipsis and never wraps. That is what the
//     100-character cap in the guide format is for.
//   - A stray keystroke would filter the choices away, so the filter value is
//     cleared on show and on every change.

export interface GateCallbacks {
  /** The human picked the choice at this index in the gate's shuffled order. */
  pick(index: number): GateVerdict | undefined;
  /** Esc — the picker goes away, the gate does not. */
  dismiss(): void;
  /** The check mark is down: the replay may move into the next step now. */
  flow(): void;
  /** Open the code the step landed (its `File:` line). */
  openCode(step: ReplayStep): void;
  /** Open the guide at this step's heading. */
  openGuide(step: ReplayStep): void;
}

type ChoiceItem = vscode.QuickPickItem & { at: number };

const OPEN_CODE: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("go-to-file"),
  tooltip: "Open the code this step landed",
};
const OPEN_GUIDE: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("book"),
  tooltip: "Open the guide at this step",
};

/** How long the check mark on a passing pick stays up before the next step arms.
 *  Long enough to read as an answer, short enough not to be a wait. */
const PASS_BEAT_MS = 450;

export class GateQuickPick implements RetroGateHost {
  private picker: vscode.QuickPick<ChoiceItem> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private closing = false; // a hide WE drove is not the human's Esc
  private gate: RetroGate | undefined;
  private step: ReplayStep | undefined;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly callbacks: GateCallbacks,
  ) {}

  show(gate: RetroGate, step: ReplayStep): void {
    this.closing = false;
    this.gate = gate;
    this.step = step;
    if (!this.picker) this.picker = this.build();
    this.render();
    this.picker.show();
    // Esc during a lockout stops the countdown with the picker. Coming back
    // mid-lockout has to resume it, or the placeholder freezes on the second it
    // left and the human reads a gate that looks stuck.
    if (gate.locked) this.startTicker();
  }

  hide(): void {
    this.closing = true;
    this.stopTicker();
    this.picker?.hide();
    this.picker?.dispose();
    this.picker = undefined;
    this.gate = undefined;
    this.step = undefined;
    // `closing` stays set: disposing fires onDidHide, and it may land after this
    // returns. show() clears it.
  }

  dispose(): void {
    this.hide();
  }

  private build(): vscode.QuickPick<ChoiceItem> {
    const picker = vscode.window.createQuickPick<ChoiceItem>();
    picker.ignoreFocusOut = true;
    picker.matchOnDescription = false;
    picker.matchOnDetail = false;
    picker.buttons = [OPEN_CODE, OPEN_GUIDE];
    // A stray keystroke would filter every choice out of a three-item list and
    // leave the human staring at an empty picker they cannot answer.
    picker.onDidChangeValue((v) => {
      if (v !== "") picker.value = "";
    });
    picker.onDidTriggerButton((b) => {
      const step = this.step;
      if (!step) return;
      if (b === OPEN_CODE) this.callbacks.openCode(step);
      else if (b === OPEN_GUIDE) this.callbacks.openGuide(step);
    });
    picker.onDidAccept(() => this.onAccept());
    picker.onDidHide(() => {
      if (this.closing) return;
      this.stopTicker();
      this.callbacks.dismiss();
    });
    return picker;
  }

  private onAccept(): void {
    const picked = this.picker?.selectedItems[0];
    if (!picked) return;
    const verdict = this.callbacks.pick(picked.at);
    if (!verdict) return;
    if (verdict.kind === "passed") {
      this.markPassed(picked.at);
      return;
    }
    if (verdict.kind === "wrong") {
      this.render();
      this.startTicker();
      return;
    }
    // Ignored: an Enter during the lockout, or a re-pick of an eliminated row.
    // Enter is a real path (a disabled item still accepts), so it is silent on
    // the surface and loud only in the log.
    this.render();
  }

  // The one beat between "right" and the next ghost: the check has to be seen,
  // or a passing pick reads as the picker simply vanishing.
  private markPassed(at: number): void {
    const picker = this.picker;
    const gate = this.gate;
    if (!picker || !gate) return;
    this.stopTicker();
    picker.items = [{ label: `$(check) ${gate.order[at].text}`, at }];
    picker.title = "Right — continuing";
    picker.placeholder = undefined;
    setTimeout(() => {
      this.hide();
      this.callbacks.flow();
    }, PASS_BEAT_MS);
  }

  // Redraw from the state machine. Called on show, on every pick, and once a
  // second while a lockout runs — the machine is the truth, this is the paint.
  private render(): void {
    const picker = this.picker;
    const gate = this.gate;
    const step = this.step;
    if (!picker || !gate || !step) return;
    const locked = gate.locked;
    const seconds = Math.ceil(gate.lockoutRemainingMs / 1000);
    // No weak-question wording here: a weak question never reaches the gate
    // (gates() refuses it and the validator FAILs the guide), so the branch
    // would be dead. The tree carries the "read it harder" wording instead.
    picker.title = `Step ${step.id} — ${gate.question}`;
    picker.placeholder = locked
      ? `Wrong. Read the Why — ${seconds}s`
      : gate.wrongCount > 0
        ? "Pick one of the remaining choices to continue"
        : "Pick one to continue. Esc steps away; the gate comes back.";

    const wrongPicks = gate.order.map((_, i) => i).filter((i) => !gate.survivors.includes(i));
    // During a lockout the wrong pick stays on screen, marked and carrying the
    // Why. Once it expires the survivors stand alone — the human is not asked to
    // re-read a choice they have already spent.
    const rows: ChoiceItem[] = locked
      ? gate.order.map((choice, i) => ({
          label: wrongPicks.includes(i) ? `$(error) ${choice.text}` : choice.text,
          detail: wrongPicks.includes(i) ? `Why this step exists: ${step.why}` : undefined,
          at: i,
          // Mouse-locked. Enter still reaches accept, which the machine rejects.
          alwaysShow: true,
        }))
      : gate.survivors.map((i) => ({ label: gate.order[i].text, at: i, alwaysShow: true }));
    picker.items = rows;
    picker.enabled = !locked;
    picker.value = "";
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = setInterval(() => {
      const gate = this.gate;
      if (!gate) {
        this.stopTicker();
        return;
      }
      if (!gate.locked) {
        this.stopTicker();
        this.output.appendLine(`[gate] step ${gate.stepId} lockout expired — ${gate.survivors.length} choice(s) offered`);
      }
      this.render();
    }, 1000);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
