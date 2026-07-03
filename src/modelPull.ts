import * as vscode from "vscode";
import { listModels, pullModel } from "./ollama";

// The model layer's UX, in the persona's language: they want "local
// autocomplete on", not a crash course in Ollama. Detect what's missing —
// server, then model — and offer each fix as a one-click gesture the human
// ratifies (invariant: nothing model-shaped happens silently). All of it over
// Ollama's HTTP API and a visible terminal, identical on every OS.

/** Start the local model server in a visible terminal — user-initiated only. */
export function startOllamaTerminal(output: vscode.OutputChannel): void {
  const existing = vscode.window.terminals.find((t) => t.name === "Ollama");
  const terminal = existing ?? vscode.window.createTerminal({ name: "Ollama" });
  terminal.show();
  terminal.sendText("ollama serve");
  output.appendLine("[ollama] started `ollama serve` in a visible terminal (user-initiated)");
}

const has = (models: string[], model: string) => models.includes(model) || models.includes(`${model}:latest`);

// The size choice, in the persona's language. No VRAM auto-detection: Ollama's
// API exposes no total-VRAM endpoint and per-OS probing is plumbing the human
// shouldn't own — an honest trade-off line beats a guess. Benchmarked on an
// RTX 5080: Fast ≈150ms per suggestion, Smart ≈200-400ms and visibly better.
const SIZES = [
  { label: "Fast", detail: "1.5b — ~1 GB download, quick on any machine", model: "qwen2.5-coder:1.5b-base" },
  { label: "Smart", detail: "7b — ~4.7 GB download, wants a capable GPU (≈8 GB VRAM)", model: "qwen2.5-coder:7b-base" },
];

// Which model to set up. A model the human explicitly configured is respected
// verbatim; the untouched default opens the Fast/Smart choice (and persists
// the pick to settings so it sticks).
async function chooseModel(configured: string): Promise<string | undefined> {
  const info = vscode.workspace.getConfiguration("humanReplay").inspect<string>("model");
  const explicit = info?.globalValue !== undefined || info?.workspaceValue !== undefined || info?.workspaceFolderValue !== undefined;
  if (explicit) return configured;
  const pick = await vscode.window.showQuickPick(
    SIZES.map((s) => ({ label: s.label, detail: s.detail, model: s.model })),
    { title: "Human Replay: choose your autocomplete model", placeHolder: "Changeable any time via humanReplay.model" },
  );
  if (!pick) return undefined;
  if (pick.model !== configured) {
    await vscode.workspace.getConfiguration("humanReplay").update("model", pick.model, vscode.ConfigurationTarget.Global);
  }
  return pick.model;
}

/**
 * The intent gesture's walk: called when the human turns autocomplete ON.
 * Server down → offer to start it (and wait for it to come up). Model absent →
 * offer the one-time download. Everything present → say it's ready. Each fix
 * is one click; declining any leaves things as they were.
 */
export async function ensureAutocompleteReady(apiBase: string, model: string, output: vscode.OutputChannel): Promise<void> {
  let models = await listModels(apiBase);
  if (models === undefined) {
    const choice = await vscode.window.showWarningMessage(
      "Human Replay: local autocomplete needs its model server, which isn't running.",
      "Start it",
    );
    if (choice !== "Start it") return;
    startOllamaTerminal(output);
    models = await waitForServer(apiBase, 15_000);
    if (models === undefined) {
      vscode.window.showWarningMessage("Human Replay: the model server didn't come up — check the Ollama terminal for what went wrong.");
      return;
    }
  }
  if (!has(models, model)) {
    const chosen = await chooseModel(model);
    if (chosen === undefined) return;
    if (!has(models, chosen)) {
      await offerModelPull(apiBase, chosen, output, "local autocomplete needs its model — a one-time download");
      return;
    }
  }
  void vscode.window.setStatusBarMessage("Human Replay: local autocomplete is ready", 3000);
}

// Poll until the just-started server answers, or the timeout passes. Startup
// is seconds; the poll keeps the one-click flow hands-free after "Start it".
async function waitForServer(apiBase: string, timeoutMs: number): Promise<string[] | undefined> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const models = await listModels(apiBase);
    if (models !== undefined) return models;
    if (Date.now() >= until) return undefined;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** One-click model download over Ollama's HTTP pull API, with live progress.
 *  Returns true when the model landed. */
export async function offerModelPull(
  apiBase: string,
  model: string,
  output: vscode.OutputChannel,
  why: string,
): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(`Human Replay: ${why}.`, "Download");
  if (choice !== "Download") return false;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Human Replay: downloading the model…", cancellable: true },
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
    void vscode.window.showInformationMessage("Human Replay: local autocomplete is ready.");
    return true;
  } catch (e) {
    if (String(e).includes("AbortError") || /aborted/i.test(String(e))) {
      output.appendLine(`[ollama] pull of ${model} cancelled`);
      return false;
    }
    output.appendLine(`[ollama] pull of ${model} failed: ${String(e)}`);
    vscode.window.showWarningMessage(`Human Replay: the download failed — ${String(e)}`);
    return false;
  }
}
