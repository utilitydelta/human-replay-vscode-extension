import * as vscode from "vscode";
import { Retrospective, isNoneQuestion, isWeak } from "./retrospective";

// The ungated step's retrospective cue: one toast, and a button that reveals the
// step in the Replay Guide tree where the question, the Why and the invariants
// live. That is the whole surface now.
//
// What used to be here was an Information diagnostic over the replayed block:
// the question as the message, the invariants as related information, an entry
// in the Problems panel, and a phase-boundary clear. It painted a whole created
// file blue, and it was ignorable — which is fatal for the one thing in the
// replay meant to be a thinking point. A step that carries distractors gets the
// gate instead (gate.ts), which cannot be ignored; a step that does not gets
// this, which is honest about being a cue rather than a stop.
//
// A `none` question is wired off on purpose and says nothing at all.
export function surfaceRetrospective(
  retro: Retrospective,
  stepIndex: number,
  output: vscode.OutputChannel,
  reveal: (index: number) => void,
): void {
  const question = retro.question.trim();
  if (!question || isNoneQuestion(question)) {
    output.appendLine(`[retrospective] ${retro.symbol}: no question wired — nothing surfaced`);
    return;
  }
  const weak = isWeak(question);
  output.appendLine(
    `[retrospective] ${retro.symbol}: ungated, ${retro.invariants.length} invariant(s), ` +
      `question ${weak ? "WEAK (smell)" : "specific"}`,
  );
  void vscode.window
    .showInformationMessage(
      weak
        ? `${retro.symbol} — the guide's question is generic, so read this step harder: ${question}`
        : `${retro.symbol} — ${question}`,
      "Show step",
    )
    .then((choice) => {
      if (choice === "Show step") reveal(stepIndex);
    });
}
