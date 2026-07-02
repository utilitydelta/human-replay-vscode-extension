import * as vscode from "vscode";
import { pullModel } from "./ollama";

// One-click model download — the "detect and guide" half of the opt-in model
// layer (invariant: nothing model-shaped happens silently; everything happens
// on a click). The warning names the model; the button pulls it through
// Ollama's HTTP API with a live progress notification, so the human never
// needs the CLI, on any OS. Returns true when the model landed.
export async function offerModelPull(
  apiBase: string,
  model: string,
  output: vscode.OutputChannel,
  why: string,
): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Human Replay: Ollama has no model "${model}" — ${why}.`,
    "Download model",
  );
  if (choice !== "Download model") return false;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Human Replay: pulling ${model}…`, cancellable: true },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        let reported = 0;
        await pullModel(apiBase, model, controller.signal, (fraction, status) => {
          if (fraction === undefined) {
            progress.report({ message: status });
            return;
          }
          const pct = Math.floor(fraction * 100);
          progress.report({ increment: pct - reported, message: `${pct}%` });
          reported = pct;
        });
      },
    );
    output.appendLine(`[ollama] pulled ${model} (user-initiated)`);
    void vscode.window.showInformationMessage(`Human Replay: ${model} is ready.`);
    return true;
  } catch (e) {
    if (String(e).includes("AbortError") || /aborted/i.test(String(e))) {
      output.appendLine(`[ollama] pull of ${model} cancelled`);
      return false;
    }
    output.appendLine(`[ollama] pull of ${model} failed: ${String(e)}`);
    vscode.window.showWarningMessage(`Human Replay: pulling ${model} failed — ${String(e)}`);
    return false;
  }
}
