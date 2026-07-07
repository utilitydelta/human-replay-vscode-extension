import * as vscode from "vscode";
import { Retrospective, isWeak } from "./retrospective";

// Surface a step's retrospective when its disclosure completes. Native, non-
// alarming: an Information diagnostic on the replayed block (navigable with F8,
// lives in the Problems panel) carrying the question and every invariant the
// step touches as related information, plus one dismissible nudge so the human
// actually sits with it. The block is the symbol for a symbol swap and only the
// changed lines for a Patch step, so the squiggle never spans untouched code. A
// weak question (smell) escalates the message; the invariants gate either way.
// No model on this path.
export function surfaceRetrospective(
  document: vscode.TextDocument,
  range: vscode.Range,
  retro: Retrospective,
  diagnostics: vscode.DiagnosticCollection,
  output: vscode.OutputChannel,
): void {
  const weak = isWeak(retro.question);

  const header = weak
    ? `Retrospective (weak — the model could not say why this exists; read it harder): ${retro.question}`
    : `Retrospective — sit with this before you move on: ${retro.question}`;

  // Information, not Hint: Hint-severity diagnostics never list in the Problems
  // panel (they render only as a faint inline underline). Information is still
  // no-red-alarm but gives the navigable Problems entry the design wants (F8).
  const diag = new vscode.Diagnostic(range, header, vscode.DiagnosticSeverity.Information);
  diag.source = "Human Replay";
  diag.relatedInformation = retro.invariants.map(
    (inv) =>
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(document.uri, range),
        `Invariant — ${inv.rule}: ${inv.reason}`,
      ),
  );

  diagnostics.set(document.uri, [diag]);
  output.appendLine(
    `[retrospective] ${retro.symbol}: ${retro.invariants.length} invariant(s), ` +
      `question ${weak ? "WEAK (smell)" : "specific"}`,
  );

  const invariantList = retro.invariants.map((i) => i.rule).join(", ");
  void vscode.window
    .showInformationMessage(
      `${retro.symbol} — ${retro.question}  (invariants: ${invariantList})`,
      "Show invariants",
    )
    .then((choice) => {
      if (choice === "Show invariants") {
        void vscode.commands.executeCommand("workbench.actions.view.problems");
      }
    });
}
