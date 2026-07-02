import * as vscode from "vscode";
import { readConfig } from "./config";
import { resolveTemplate } from "./templates";
import { generateFim } from "./ollama";
import { postprocess } from "./postprocess";
import { DisclosureController } from "./disclosure/controller";
import { DiffReplayController } from "./disclosure/diffReplayController";

/**
 * Turns a cursor position into a FIM request and returns ghost-text. The human
 * reads every suggestion and ratifies it with a Tab press — the model only ever
 * proposes the next few lines, it never authors unread.
 *
 * When a disclosure session is active this provider yields to it: the ghost is
 * the next AST descent step, served model-free, never the FIM path.
 */
export class ReplayTabCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private lastCompletion = "";
  private lastKey = "";
  // Suppress the per-keystroke error spam when Ollama is simply not running.
  private offline = false;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly disclosure: DisclosureController,
    private readonly diffReplay: DiffReplayController,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (this.disclosure.isActive(document)) {
      const item = this.disclosure.currentItem(document, position);
      return item ? [item] : undefined;
    }

    if (this.diffReplay.isActive(document)) {
      const item = this.diffReplay.currentItem(document, position);
      return item ? [item] : undefined;
    }

    const cfg = readConfig();
    if (!cfg.enabled) {
      return undefined;
    }

    const fullPrefix = document.getText(
      new vscode.Range(new vscode.Position(0, 0), position),
    );
    const lastLine = document.lineCount - 1;
    const fullSuffix = document.getText(
      new vscode.Range(
        position,
        document.lineAt(lastLine).range.end,
      ),
    );

    const prefix = fullPrefix.slice(-cfg.prefixChars);
    const suffix = fullSuffix.slice(0, cfg.suffixChars);

    // Cheap cache: if nothing relevant changed, reuse the last suggestion.
    const key = `${prefix}\0${suffix}`;
    if (key === this.lastKey && this.lastCompletion) {
      return [new vscode.InlineCompletionItem(this.lastCompletion)];
    }

    // Debounce automatic triggers so we don't fire on every keystroke.
    const automatic =
      context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
    if (automatic && cfg.debounceMs > 0) {
      const cancelled = await sleep(cfg.debounceMs, token);
      if (cancelled) {
        return undefined;
      }
    }
    if (token.isCancellationRequested) {
      return undefined;
    }

    const template = resolveTemplate(cfg.template, cfg.model);
    const prompt = template.build(prefix, suffix);

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    try {
      const started = Date.now();
      const raw = await generateFim({
        apiBase: cfg.apiBase,
        model: cfg.model,
        prompt,
        stop: template.stop,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        signal: controller.signal,
      });

      const completion = postprocess(raw, {
        stop: template.stop,
        multiline: cfg.multiline,
        suffix,
      });

      if (token.isCancellationRequested || !completion) {
        return undefined;
      }

      this.output.appendLine(
        `[replay-tab] ${Date.now() - started}ms, ${completion.length} chars`,
      );
      if (this.offline) {
        this.output.appendLine("[replay-tab] model reachable again");
        this.offline = false;
      }

      this.lastKey = key;
      this.lastCompletion = completion;

      return [
        new vscode.InlineCompletionItem(
          completion,
          new vscode.Range(position, position),
        ),
      ];
    } catch (err) {
      if (controller.signal.aborted || token.isCancellationRequested) {
        return undefined;
      }
      // Ollama not running is the common case (the model layer is opt-in). Log it
      // once, not on every keystroke, and stay quiet until it comes back.
      const offline = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(String(err));
      if (offline) {
        if (!this.offline) {
          this.offline = true;
          this.output.appendLine(
            "[replay-tab] model unreachable — autocomplete off until it returns " +
              "(disclosure is unaffected; it never uses the model)",
          );
        }
      } else {
        this.output.appendLine(`[replay-tab] error: ${String(err)}`);
      }
      return undefined;
    }
  }
}

/** Resolves to true if cancelled during the wait, false otherwise. */
function sleep(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve(false);
    }, ms);
    const disposable = token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
