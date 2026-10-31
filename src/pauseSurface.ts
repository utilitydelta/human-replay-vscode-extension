import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { RECORD_GITATTRIBUTES } from "./disclosure/replayRecord";
import { ReplayStep } from "./disclosure/guide";
import { PauseHost } from "./disclosure/guideRunner";

// The surfaces for steps that type nothing, and the record files.
//
// Code to read opens in a virtual document beside the editor. A content
// provider's document is read-only by construction: no save prompt, no stray
// keystroke landing in a caller the human does not own.
//
// A ruling is a QuickPick, like the retrospective gate, with two differences.
// Nothing is active on open, so Enter alone picks nothing and the recommended
// option is a choice the human makes rather than one they fall through to. And
// there is no right answer, so there is no lockout.

export const VIEW_SCHEME = "human-replay-view";

class ReadOnlyViews implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private seq = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? "";
  }

  /** A fresh uri per view, ending in the file's basename so VS Code picks the language. */
  add(title: string, text: string, file: string): vscode.Uri {
    this.seq++;
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, " ").trim() || "view";
    // The tab shows only the last segment, so it must not pass for the real
    // file: "codec (read only).rs" keeps the extension for highlighting.
    const ext = path.extname(file);
    const name = `${path.basename(file, ext) || "view"} (read only)${ext}`;
    const uri = vscode.Uri.from({ scheme: VIEW_SCHEME, path: `/${this.seq} ${safeTitle}/${name}` });
    this.texts.set(uri.toString(), text);
    return uri;
  }
}

type OptionItem = vscode.QuickPickItem & { option: string };

export class ReplayPauseSurface implements PauseHost {
  private readonly views = new ReadOnlyViews();
  private picker: vscode.QuickPick<OptionItem> | undefined;
  private onPick: ((choice: string) => void) | undefined;
  private closing = false;
  // The step whose recap is already open beside: a re-show brings the picker
  // back without stacking another copy of the recap.
  private recapFor: string | undefined;

  constructor(
    private readonly output: vscode.OutputChannel,
    /** The folder the record files go in: humanReplay.recordDir, else the guide's own folder. */
    private readonly recordDir: () => string | undefined,
  ) {}

  register(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(VIEW_SCHEME, this.views);
  }

  showCode(title: string, text: string, file: string, focus = false): void {
    const uri = this.views.add(title, text, file);
    void vscode.workspace
      .openTextDocument(uri)
      .then((doc) => vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false, preserveFocus: !focus }));
  }

  showRuling(step: ReplayStep, pick: (choice: string) => void): void {
    const ruling = step.ruling;
    if (!ruling) return;
    this.onPick = pick;
    // The recap is the step's Why, plus its own fence when the guide shows code
    // with it. A picker row truncates, so the recap reads beside it instead.
    const recap = [
      `# ${ruling.decision}: ${step.title}`,
      "",
      step.why,
      "",
      `Options: ${ruling.options.join(" | ")}`,
      ruling.recommend ? `Recommended: ${ruling.recommend}` : "No recommendation.",
      ...(step.after !== undefined ? ["", "```", step.after, "```"] : []),
      "",
    ].join("\n");
    if (this.recapFor !== step.id) this.showCode(`${ruling.decision} recap`, recap, `${ruling.decision}.md`);
    this.recapFor = step.id;
    if (!this.picker) this.picker = this.build();
    this.closing = false;
    this.picker.title = `Rule ${ruling.decision} by name (step ${step.id})`;
    this.picker.placeholder = "Pick one. Esc hides this; Tab brings it back.";
    this.picker.items = ruling.options.map((option) => ({
      label: option,
      description: option === ruling.recommend ? "recommended" : undefined,
      option,
    }));
    this.picker.value = "";
    this.picker.show();
    this.picker.activeItems = [];
  }

  closeViews(): void {
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === VIEW_SCHEME);
    if (tabs.length > 0) void vscode.window.tabGroups.close(tabs, true);
  }

  hideRuling(): void {
    this.onPick = undefined;
    this.recapFor = undefined;
    if (!this.picker) return;
    this.closing = true;
    this.picker.hide();
  }

  private who: string | undefined;

  /** The git user of the workspace, read once; the OS user when git has none. */
  author(): string {
    if (this.who !== undefined) return this.who;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let name = "";
    try {
      name = execFileSync("git", ["config", "user.name"], { cwd, encoding: "utf8", timeout: 2000 }).trim();
    } catch {
      // no git, or no user.name set
    }
    this.who = name || os.userInfo().username;
    return this.who;
  }

  /** A record file's text, or undefined when there is no folder or no file yet. */
  readRecord(file: "rulings.jsonl" | "unit-times.jsonl"): string | undefined {
    const dir = this.recordDir();
    if (!dir) return undefined;
    try {
      return fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      return undefined;
    }
  }

  record(file: "rulings.jsonl" | "unit-times.jsonl", line: string): void {
    const dir = this.recordDir();
    if (!dir) {
      this.output.appendLine(`[record] no folder to write ${file} into — dropped: ${line.trim()}`);
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const attributes = path.join(dir, ".gitattributes");
      if (!fs.existsSync(attributes)) fs.writeFileSync(attributes, RECORD_GITATTRIBUTES);
      fs.appendFileSync(path.join(dir, file), line);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.output.appendLine(`[record] ${file} write failed (${msg}) — ${line.trim()}`);
      void vscode.window.showWarningMessage(`Human Replay: could not write ${file} in ${dir}: ${msg}`);
    }
  }

  dispose(): void {
    this.picker?.dispose();
  }

  private build(): vscode.QuickPick<OptionItem> {
    const picker = vscode.window.createQuickPick<OptionItem>();
    picker.ignoreFocusOut = true;
    picker.matchOnDescription = false;
    picker.onDidAccept(() => {
      // Enter with nothing highlighted is not a pick.
      const chosen = picker.activeItems[0] ?? picker.selectedItems[0];
      if (!chosen) return;
      const pick = this.onPick;
      this.hideRuling();
      pick?.(chosen.option);
    });
    picker.onDidHide(() => {
      if (this.closing) {
        this.closing = false;
        return;
      }
      this.output.appendLine("[ruling] picker dismissed — the ruling stands; the next run gesture re-shows it");
    });
    return picker;
  }
}
