import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HumanReplayCompletionProvider } from "./completionProvider";
import { DisclosureController } from "./disclosure/controller";
import { DiffReplayController } from "./disclosure/diffReplayController";
import { ReplayOrchestrator } from "./disclosure/orchestrator";
import { GuideRunner } from "./disclosure/guideRunner";
import { GuideTreeProvider } from "./disclosure/guideTree";
import { CommentLayer } from "./disclosure/comments";
import { buildMessages, generatePrompt } from "./disclosure/promptgen";
import { setIsActionable } from "./disclosure/actionability";
import { readConfig } from "./config";
import { offerModelPull } from "./modelPull";
import { surfaceRetrospective } from "./retrospective/surface";

// Detect-and-guide for the opt-in model layer (invariant 2, decision #4): never
// auto-spawn Ollama on activation or F5. Only when a model action finds it
// unreachable do we offer a one-click that runs `ollama serve` in a visible
// terminal — the human stays in control of whether inference is even running.
function startOllamaTerminal(output: vscode.OutputChannel): void {
  const existing = vscode.window.terminals.find((t) => t.name === "Ollama");
  const terminal = existing ?? vscode.window.createTerminal({ name: "Ollama" });
  terminal.show();
  terminal.sendText("ollama serve");
  output.appendLine("[ollama] started `ollama serve` in a visible terminal (user-initiated)");
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Human Replay");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.startOllama", () => startOllamaTerminal(output)),
  );

  const retrospectives = vscode.languages.createDiagnosticCollection("replay-retrospective");
  context.subscriptions.push(retrospectives);

  const disclosure = new DisclosureController(output);
  const diffReplay = new DiffReplayController(output);
  const orchestrator = new ReplayOrchestrator(output, disclosure, diffReplay);
  const guideRunner = new GuideRunner(output, disclosure, orchestrator);
  const provider = new HumanReplayCompletionProvider(output, disclosure, diffReplay);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      provider,
    ),
  );

  // When a walk completes, surface its retrospective over the disclosed symbol —
  // the step end is the thinking point the human sits with before moving on.
  disclosure.setCompletionHandler((session) => {
    guideRunner.completeCurrent(); // advance the program counter when the walk finishes
    if (!session.retrospective) return;
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === session.uri.toString(),
    );
    if (!doc) return;
    const range = new vscode.Range(
      doc.positionAt(session.anchorOffset),
      doc.positionAt(session.anchorOffset + session.sourceLength),
    );
    surfaceRetrospective(doc, range, session.retrospective, retrospectives, output);
  });

  // Same thinking-point hook for a completed diff-replay walk: the modification
  // beat ends on the invariant-tagged retrospective the human must sit with.
  // A delete's whole gesture is the strike-and-clear — no walk follows, so the
  // clear itself advances the counter. The retrospective has no symbol left to
  // anchor on; surface its question as a message instead of a gate.
  orchestrator.setDeleteCompletionHandler((retro) => {
    guideRunner.completeCurrent();
    if (retro) void vscode.window.showInformationMessage(`Human Replay — retrospective for ${retro.symbol}: ${retro.question}`);
  });

  diffReplay.setCompletionHandler((done) => {
    guideRunner.completeCurrent(); // advance the program counter when the walk finishes
    if (!done.retrospective) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === done.uri.toString());
    if (!doc) return;
    const range = new vscode.Range(
      doc.positionAt(done.anchorOffset),
      doc.positionAt(done.anchorOffset + done.symbolLen),
    );
    surfaceRetrospective(doc, range, done.retrospective, retrospectives, output);
  });

  // Post-accept hooks and the Tab/keybinding targets the walks route through.
  // Not palette commands — they are the accept half of each surface: the native
  // ghost's command, the dramatic decoration's Tab, and the rewrite strike's Tab.
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.disclosureAccepted", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) disclosure.onAccepted(editor);
    }),
    vscode.commands.registerCommand("humanReplay.diffReplayAccepted", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) diffReplay.onAccepted(editor);
    }),
    vscode.commands.registerCommand("humanReplay.diffReplayAcceptDecoration", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) void diffReplay.acceptDecoration(editor);
    }),
    vscode.commands.registerCommand("humanReplay.acceptRewriteClear", () => void orchestrator.acceptRewriteClear()),
  );

  // Surfacing layer: collate inline comments while reading the replay, then take
  // one of three exits. "Pull into prompt" runs the S10 template through the local
  // instruct model — pre-gated (no comments → no call) with the human reading the
  // generated prompt before anything sends (invariant 2; S10 proved both mandatory).
  const comments = new CommentLayer(output);
  context.subscriptions.push(comments);
  // Keep note bubbles on the code they were about as the replay shifts the buffer.
  // Cheap: only re-parses while notes are actually collated.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (comments.count > 0 && e.contentChanges.length > 0) comments.reanchor();
      disclosure.noteChange(e); // detect the human authoring mid-walk → re-anchored mode
      diffReplay.noteChange(e); // same, for the modify path: re-anchor or surface a collision
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.comments.add", (reply: vscode.CommentReply) => comments.add(reply)),
    vscode.commands.registerCommand("humanReplay.comments.clear", () => comments.clear()),
    vscode.commands.registerCommand("humanReplay.comments.nextBlock", () => comments.nextBlock()),
    vscode.commands.registerCommand("humanReplay.comments.pullPrompt", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (comments.count === 0) {
        vscode.window.showInformationMessage("Human Replay: no comments to pull — nothing to send.");
        return; // model-free pre-gate: never call the model with nothing
      }
      // Model-free actionability gate (S10): the 7B fabricates a task from vague
      // notes no matter how it's prompted, so screen upstream. The human can still
      // override — this is a smell, not a lock (invariant 2: the human decides).
      if (!setIsActionable(comments.comments.map((c) => c.text))) {
        output.appendLine("[comments] actionability gate: notes look too vague to act on");
        const choice = await vscode.window.showWarningMessage(
          "Human Replay: these notes look too vague to act on. A local model tends to fabricate a task from low-information comments. Send anyway?",
          { modal: true },
          "Send anyway",
        );
        if (choice !== "Send anyway") return;
      }
      const cfg = readConfig();
      const model = vscode.workspace.getConfiguration("humanReplay").get<string>("promptModel", "qwen2.5-coder:7b-instruct");
      const code = editor.document.getText();
      const messages = buildMessages("the function under review", code, comments.comments);
      try {
        const prompt = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Human Replay: generating prompt (${model})…` },
          () => generatePrompt(cfg.apiBase, model, messages),
        );
        // Human reads (and may edit) before it ever sends — the S10 backstop.
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: `<!-- Review this prompt, edit if needed, then send to the sandbox agent. -->\n<!-- (sending is not wired in this slice — this is the read-before-send gate.) -->\n\n${prompt}\n`,
        });
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (e) {
        const msg = String(e);
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
          void vscode.window
            .showWarningMessage(
              `Human Replay: can't reach Ollama at ${cfg.apiBase}. Start it, then pull an instruct model: ollama pull ${model}`,
              "Start Ollama",
            )
            .then((choice) => {
              if (choice === "Start Ollama") startOllamaTerminal(output);
            });
        } else if (/not found|no such model|model/i.test(msg)) {
          void offerModelPull(cfg.apiBase, model, output, "the prompt generator needs an instruct model (or set humanReplay.promptModel)");
        } else {
          vscode.window.showWarningMessage(`Human Replay: prompt generation failed — ${msg}`);
        }
      }
    }),
  );

  // Bail out of whatever the replay is showing — insert walk, diff-replay
  // decorations, or a rewrite strike. One gesture (Esc / palette), every engine;
  // the buffer stays as-is and the guide step stays current for a re-run.
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.cancelDisclosure", () => {
      disclosure.cancel();
      orchestrator.cancelAll();
      guideRunner.cancelInFlight(); // a stray completion must not mark the cancelled step done
    }),
  );

  // Replay-guide ingestion (the keystone). Load a canonical guide, then replay its
  // steps — each routes itself by its action (create→disclose, modify→auto-routed
  // diff-replay, delete→strike). Model-free: the route is read from the guide, the
  // bytes are the guide's real sandbox bytes. The program counter is the position.
  const clearGate = (doc: vscode.TextDocument) => retrospectives.delete(doc.uri);

  // Program-counter indicator: the replay's position, always visible while a guide
  // is loaded. Click to run the next step.
  const guideStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  guideStatus.command = "humanReplay.runNextStep";
  context.subscriptions.push(guideStatus);
  const updateGuideStatus = () => {
    if (!guideRunner.loaded) {
      guideStatus.hide();
      return;
    }
    const total = guideRunner.steps.length;
    const done = guideRunner.isComplete;
    const at = Math.min(guideRunner.counter + 1, total);
    guideStatus.text = done
      ? `$(check) Replay: ${guideRunner.feature} ${total}/${total}`
      : `$(debug-step-over) Replay: ${guideRunner.feature} ${at}/${total}`;
    guideStatus.tooltip = done ? "Replay complete" : "Click to run the next replay step";
    guideStatus.show();
  };

  // The replay-guide panel (TreeView): phases → steps → status. Refreshes whenever
  // the runner's state changes; clicking a step runs it, the inline icons run/skip.
  const guideTree = new GuideTreeProvider(guideRunner);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("humanReplay.guideSteps", guideTree));
  guideRunner.setChangeHandler(() => {
    guideTree.refresh();
    updateGuideStatus();
    persistPosition(); // every done/skip lands in workspaceState — a reload resumes here
    void vscode.commands.executeCommand("setContext", "humanReplay.guideLoaded", guideRunner.loaded);
  });
  // A re-anchored continue that can't place the next node marks the in-flight step
  // blocked — the panel shows amber and the human decides. Both engines surface the
  // same way: the insert walk's continue and the modify path's re-anchored step.
  disclosure.setCollisionHandler(() => guideRunner.markCurrentBlocked());
  diffReplay.setCollisionHandler(() => guideRunner.markCurrentBlocked());
  // Tab after the human diverges drives the re-anchored continue (gated by context).
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.continueDisclosure", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) void disclosure.continueWalk(editor);
    }),
  );
  // Mid-walk, between an accept and the next ghost, a too-fast Tab would fall
  // through to the editor's indent action — literal tab bytes typed into the
  // half-built symbol (the fast-Tab corruption). While the walk is active and
  // no ghost is up, Tab nudges the ghost instead of typing.
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.nudgeGhost", () => {
      void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    }),
  );
  // Same protection for diff-replay's native surface: Tab with a step armed but
  // no ghost visible re-triggers when the cursor is on the armed line, and is a
  // plain indent everywhere else. Without this, a swallowed trigger turns Tab
  // into typed bytes ON the armed line — the stray-indent corruption.
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.diffReplayNudge", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !(await diffReplay.nudge(editor))) {
        await vscode.commands.executeCommand("tab");
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.guide.runStepAt", async (node?: { index: number }) => {
      if (!node) return;
      await guideRunner.runStep(node.index, clearGate);
    }),
    vscode.commands.registerCommand("humanReplay.guide.skipStepAt", (node?: { index: number }) => {
      if (node) guideRunner.skip(node.index);
    }),
  );

  const resolveGuideUris = async (): Promise<vscode.Uri[]> => {
    const explicit = vscode.workspace.getConfiguration("humanReplay").get<string>("guidePath", "").trim();
    if (explicit) {
      // Absolute/workspace path or a glob — both go through findFiles relative to
      // the workspace; an absolute path resolves directly.
      if (explicit.startsWith("/")) return [vscode.Uri.file(explicit)];
      return vscode.workspace.findFiles(explicit);
    }
    return vscode.workspace.findFiles("replay-guides/*.md");
  };

  // Where a resumed replay's position lives: workspaceState, keyed by the guide
  // file. Done/skipped survive a window reload; the byte-derived pass on load
  // catches anything the saved position missed (or a lost workspaceState).
  const positionKey = (guide: vscode.Uri) => `humanReplay.replay:${guide.fsPath}`;
  let currentGuideUri: vscode.Uri | undefined;
  const persistPosition = () => {
    if (currentGuideUri && guideRunner.loaded) {
      void context.workspaceState.update(positionKey(currentGuideUri), guideRunner.snapshot());
    }
  };

  // Load a guide and pick up where the last session stopped: restore the saved
  // position, then re-derive done-ness from the real bytes on both sides.
  const loadGuideFrom = async (uri: vscode.Uri): Promise<boolean> => {
    const md = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    // Read the saved position BEFORE load(): load fires changed() → persistPosition,
    // and with the key still current a RE-load would clobber its own save with the
    // freshly-reset counter. Parking the key while loading closes the race.
    const saved = context.workspaceState.get<{ done?: number[]; skipped?: number[] }>(positionKey(uri));
    currentGuideUri = undefined;
    const guide = guideRunner.load(md);
    currentGuideUri = uri;
    // Only skips restore from the snapshot — a skip is human intent the bytes can't
    // derive. Done-ness re-derives from ground truth below (resume.ts's thesis):
    // a step reverted out-of-band must fall back to pending, not stay green off a
    // stale counter.
    if (saved?.skipped?.length) guideRunner.restore({ skipped: saved.skipped });
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const derived = root ? guideRunner.deriveLanded(root) : 0;
    updateGuideStatus();
    const done = guide.steps.length - guideRunner.steps.filter((_, i) => guideRunner.status(i) === "pending" || guideRunner.status(i) === "current").length;
    vscode.window.showInformationMessage(
      done > 0
        ? `Human Replay: resumed "${guide.feature}" at step ${Math.min(guideRunner.counter + 1, guide.steps.length)}/${guide.steps.length}` +
            (derived > 0 ? ` (${derived} step(s) already landed in the target)` : "")
        : `Human Replay: loaded "${guide.feature}" — ${guide.steps.length} steps.`,
    );
    return true;
  };

  // THE entry point — the whole dev flow starts here. Pick a sandbox (last one
  // pinned; "self-contained" for a fence-embedded guide that needs none), find
  // its guide, resume from ground truth, and flow straight into the next step.
  // One command from "open the target repo" to "tabbing code in".
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.startReplay", async () => {
      const cfg = vscode.workspace.getConfiguration("humanReplay");
      const configured = cfg.get<string>("sandboxParent", "").trim();
      const parent = configured
        ? configured.replace(/^~(?=$|\/)/, os.homedir())
        : path.join(os.homedir(), "sandbox");

      let dirs: { name: string; full: string; mtime: number }[] = [];
      try {
        dirs = fs
          .readdirSync(parent, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => {
            const full = path.join(parent, d.name);
            return { name: d.name, full, mtime: fs.statSync(full).mtimeMs };
          })
          .sort((a, b) => b.mtime - a.mtime);
      } catch {
        // No sandbox folder is not a dead end — self-contained guides still replay.
        output.appendLine(`[replay] no sandbox folder at ${parent}`);
      }

      const last = context.workspaceState.get<{ sandbox: string; guide: string }>("humanReplay.lastReplay");
      type SandboxItem = vscode.QuickPickItem & { full?: string };
      const items: SandboxItem[] = dirs.map((d) => ({
        label: d.name,
        description: d.full === last?.sandbox ? "last replay" : undefined,
        detail: fs.existsSync(path.join(d.full, "replay-guides")) ? "has replay-guides/" : undefined,
        full: d.full,
      }));
      // The sandbox being resumed is almost always the one you want — pin it first.
      items.sort((a, b) => (a.description ? -1 : 0) - (b.description ? -1 : 0));
      items.push({
        label: "$(file-code) No sandbox — self-contained guide",
        detail: "A guide with embedded Before/After bytes (workspace replay-guides/ or humanReplay.guidePath)",
      });
      const sandboxPick = await vscode.window.showQuickPick(items, {
        title: "Human Replay: replay from which sandbox?",
        placeHolder: "The sandbox holding the agent's finished work (the After bytes)",
      });
      if (!sandboxPick) return;
      guideRunner.setSandboxRoot(sandboxPick.full);
      output.appendLine(`[replay] sandbox: ${sandboxPick.full ?? "(none — self-contained guide)"}`);

      // The guide lives with the sandbox (the generator writes it there). Fall back
      // to the workspace's replay-guides/ or humanReplay.guidePath for hand-authored
      // guides kept elsewhere; the no-sandbox pick goes straight to those.
      const sandboxGuides = ((): vscode.Uri[] => {
        if (!sandboxPick.full) return [];
        const dir = path.join(sandboxPick.full, "replay-guides");
        try {
          return fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => vscode.Uri.file(path.join(dir, f)));
        } catch {
          return [];
        }
      })();
      const guides = sandboxGuides.length > 0 ? sandboxGuides : await resolveGuideUris();
      if (guides.length === 0) {
        vscode.window.showWarningMessage(
          sandboxPick.full
            ? `Human Replay: no guide in ${sandboxPick.full}/replay-guides/ and none in the workspace. Generate one, or set humanReplay.guidePath.`
            : "Human Replay: no replay guide found. Add one under replay-guides/ or set humanReplay.guidePath.",
        );
        return;
      }
      const guidePick =
        guides.length === 1
          ? guides[0]
          : await vscode.window
              .showQuickPick(
                guides.map((u) => ({ label: path.basename(u.fsPath), description: u.fsPath, uri: u })),
                { title: "Human Replay: choose a replay guide" },
              )
              .then((c) => c?.uri);
      if (!guidePick) return;

      try {
        await loadGuideFrom(guidePick);
      } catch (e) {
        // A malformed guide is canonical-source corruption: surface it, don't swallow.
        vscode.window.showErrorMessage(`Human Replay: ${String(e)}`);
        return;
      }
      if (sandboxPick.full) {
        void context.workspaceState.update("humanReplay.lastReplay", {
          sandbox: sandboxPick.full,
          guide: guidePick.fsPath,
        });
      }
      await guideRunner.runCurrent(clearGate);
      updateGuideStatus();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.runNextStep", async () => {
      if (!guideRunner.loaded) {
        // Nothing mid-flight (fresh window, reloaded session) — route into the
        // entry point; its last-replay pin makes the resume two keystrokes.
        await vscode.commands.executeCommand("humanReplay.startReplay");
        return;
      }
      await guideRunner.runCurrent(clearGate);
      updateGuideStatus();
    }),
  );

  // The single trigger path: a cursor landing on the current step's anchor shows
  // the ghost (next step after an accept, or a restored ghost after wandering).
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.selections.length !== 1) return;
      const doc = e.textEditor.document;
      const at = e.selections[0].active;
      if (disclosure.isActive(doc)) void disclosure.onSelectionChanged(doc, at);
      else if (diffReplay.isActive(doc)) void diffReplay.onSelectionChanged(doc, at);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.toggle", async () => {
      const cfg = vscode.workspace.getConfiguration("humanReplay");
      const next = !cfg.get<boolean>("enabled", true);
      await cfg.update(
        "enabled",
        next,
        vscode.ConfigurationTarget.Global,
      );
      vscode.window.setStatusBarMessage(
        `Human Replay ${next ? "enabled" : "disabled"}`,
        2000,
      );
    }),
  );

  output.appendLine("[human-replay] activated");
}

export function deactivate() {
  // Nothing to clean up — the provider holds no external resources.
}
