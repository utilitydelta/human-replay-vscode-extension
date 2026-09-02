import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ReplayGhostProvider } from "./ghostProvider";
import { DisclosureController } from "./disclosure/controller";
import { DiffReplayController } from "./disclosure/diffReplayController";
import { ReplayOrchestrator } from "./disclosure/orchestrator";
import { GuideRunner } from "./disclosure/guideRunner";
import { GuideTreeProvider } from "./disclosure/guideTree";
import { surfaceRetrospective } from "./retrospective/surface";
import { GateQuickPick } from "./retrospective/gateSurface";
import { PendingGate } from "./retrospective/gate";

// Every line carries a wall clock. Without it the channel says what happened
// and in what order, but never WHERE THE TIME WENT — and "it feels slow between
// Tabs" is a question about gaps between lines, not about the lines. Reading a
// gap beats inferring one from a stopwatch that might be measuring think time.
function timestamped(channel: vscode.OutputChannel): vscode.OutputChannel {
  const stamp = (): string => {
    const d = new Date();
    return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  };
  return {
    get name() {
      return channel.name;
    },
    append: (v: string) => channel.append(v),
    appendLine: (v: string) => channel.appendLine(`${stamp()} ${v}`),
    replace: (v: string) => channel.replace(v),
    clear: () => channel.clear(),
    show: (a?: unknown, b?: unknown) => (channel.show as (a?: unknown, b?: unknown) => void)(a, b),
    hide: () => channel.hide(),
    dispose: () => channel.dispose(),
  } as vscode.OutputChannel;
}

export function activate(context: vscode.ExtensionContext) {
  const channel = vscode.window.createOutputChannel("Human Replay");
  context.subscriptions.push(channel);
  const output = timestamped(channel);
  // Anything slower than this between a Tab and its result is felt, not
  // measured. Below it, silence: the log is evidence, not telemetry.
  const SLOW_TAB_MS = 80;

  const disclosure = new DisclosureController(output);
  const diffReplay = new DiffReplayController(output);
  context.subscriptions.push(diffReplay);
  const orchestrator = new ReplayOrchestrator(output, disclosure, diffReplay);
  const guideRunner = new GuideRunner(output, disclosure, orchestrator);
  // The ghost surface both engines render through. It proposes only what a
  // running replay already holds — no replay, no ghost.
  // Tab-to-Tab latency, measured where the human feels it: from the accept
  // landing to the next ghost appearing. A handler that returns instantly and a
  // ghost that arrives a second later are the same experience, and only this
  // number tells them apart.
  let lastAcceptAt: number | undefined;
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      new ReplayGhostProvider(disclosure, diffReplay, (engine) => {
        if (lastAcceptAt === undefined) return;
        const ms = Date.now() - lastAcceptAt;
        lastAcceptAt = undefined;
        // Above the handler threshold plus the trigger's grace window: a ghost
        // that lands at ~140ms is the normal path now, and a perf line that
        // fires every time is noise. Noise is how a think-time number got read
        // as latency twice in this hunt.
        if (ms >= SLOW_TAB_MS + 170) output.appendLine(`[perf] ${engine}: next ghost arrived ${ms}ms after the accept`);
      }),
    ),
  );

  // Every engine reports the same way: the walk finished, tell the counter. What
  // happens next — the gate, the toast, or straight into the next step — is one
  // decision in the runner (completeCurrent), not three copies out here. A
  // delete has no walk after its strike-and-clear, so the clear reports too.
  // What the last step put on screen, so the dwell can point at it. The engines
  // already carry the range; nothing else consumes it now that the squiggle is
  // gone. A delete leaves nothing to point at.
  let lastLanded: { uri: vscode.Uri; offset: number; length: number } | undefined;
  disclosure.setCompletionHandler((session) => {
    lastLanded = { uri: session.uri, offset: session.anchorOffset, length: session.sourceLength };
    guideRunner.completeCurrent();
  });
  diffReplay.setCompletionHandler((done) => {
    lastLanded = { uri: done.uri, offset: done.retroOffset, length: done.retroLen };
    guideRunner.completeCurrent();
  });
  orchestrator.setDeleteCompletionHandler(() => {
    lastLanded = undefined;
    guideRunner.completeCurrent();
  });

  // Post-accept hooks and the Tab/keybinding targets the walks route through.
  // Not palette commands — they are the accept half of each surface: the native
  // ghost's command, the dramatic decoration's Tab, and the rewrite strike's Tab.
  // A Tab that takes longer than a frame or two is the difference between the
  // replay feeling like typing and feeling like a form submission. Every Tab
  // path reports its own cost, so "there is a delay" becomes a line in the
  // output channel naming the handler instead of a hunt.
  const timed = <T>(name: string, fn: () => T): T => {
    const started = Date.now();
    const done = (): void => {
      const ms = Date.now() - started;
      lastAcceptAt = Date.now(); // the ghost race starts when the handler is done
      if (ms >= SLOW_TAB_MS) output.appendLine(`[perf] ${name} took ${ms}ms`);
    };
    const out = fn();
    if (out instanceof Promise) return out.finally(done) as T;
    done();
    return out;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.disclosureAccepted", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) timed("disclosureAccepted", () => disclosure.onAccepted(editor));
    }),
    vscode.commands.registerCommand("humanReplay.diffReplayAccepted", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) timed("diffReplayAccepted", () => diffReplay.onAccepted(editor));
    }),
    vscode.commands.registerCommand("humanReplay.diffReplayAcceptDecoration", async () => {
      const editor = vscode.window.activeTextEditor;
      // A stale context must not make Tab a dead key: unhandled falls through
      // to the editor's real indent.
      if (!editor || !(await timed("diffReplayAcceptDecoration", () => diffReplay.acceptDecoration(editor)))) {
        await vscode.commands.executeCommand("tab");
      }
    }),
    vscode.commands.registerCommand("humanReplay.acceptRewriteClear", async () => {
      if (!(await timed("acceptRewriteClear", () => orchestrator.acceptRewriteClear()))) {
        await vscode.commands.executeCommand("tab");
      }
    }),
    vscode.commands.registerCommand("humanReplay.skipHunk", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) diffReplay.skipCurrent(editor);
    }),
  );

  // Both engines watch the buffer for the human authoring mid-step: the walk
  // switches to re-anchored mode, the modify path re-anchors or surfaces a
  // collision. Ground truth is the bytes, so the bytes are what we watch.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      disclosure.noteChange(e);
      diffReplay.noteChange(e);
    }),
  );
  // Bail out of whatever the replay is showing — insert walk, diff-replay
  // decorations, or a rewrite strike. One gesture (Esc / palette), every engine;
  // the buffer stays as-is and the guide step stays current for a re-run. This
  // cancels the STEP, not the session — End Replay Session is the full stop.
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.cancelDisclosure", () => {
      disclosure.cancel();
      orchestrator.cancelAll();
      guideRunner.cancelInFlight(); // a stray completion must not mark the cancelled step done
    }),
  );

  // The rollback gesture: re-read every step's status from the bytes on disk.
  // Rolling a file back mid-session left stale green ticks — the counter is
  // memory, and nothing re-reads bytes until the next load.
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.resync", () => {
      if (!guideRunner.loaded) {
        vscode.window.showInformationMessage("Human Replay: no replay session to resync — run Start Replay first.");
        return;
      }
      disclosure.cancel();
      orchestrator.cancelAll();
      guideRunner.cancelInFlight();
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (root) guideRunner.resync(root);
      updateGuideStatus();
      vscode.window.setStatusBarMessage("Human Replay: step statuses re-derived from your files", 3000);
    }),
  );

  // The full stop: tear down the engines AND unload the guide, so the panel
  // and status bar retire. Position survives in workspaceState and re-derives
  // from bytes on the next Start Replay.
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.endReplay", () => {
      disclosure.cancel();
      orchestrator.cancelAll();
      guideRunner.cancelInFlight();
      guideRunner.unload();
      vscode.window.setStatusBarMessage("Human Replay: replay session ended", 3000);
    }),
  );

  // Replay-guide ingestion (the keystone). Load a canonical guide, then replay its
  // steps — each routes itself by its action (create→disclose, modify→auto-routed
  // diff-replay, delete→strike). Model-free: the route is read from the guide, the
  // bytes are the guide's real sandbox bytes. The program counter is the position.
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
    // The gate outranks every other state: nothing flows until it is answered,
    // so the status bar says exactly that, in the same warning colour a phase
    // pause uses. Esc hides the picker, not the gate — this is what tells the
    // human the door is still shut.
    const gated = guideRunner.gateStep;
    if (gated) {
      guideStatus.text = "$(question) answer the retrospective to continue";
      guideStatus.tooltip = `Step ${gated.id} is done. Answer its retrospective to continue — click here (or press Tab) to bring the question back.`;
      guideStatus.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      guideStatus.show();
      return;
    }
    // The hold on what just landed. It is the only status-bar state that
    // counts down, because "how long have I got" is the whole question the
    // human asks while reading.
    const dwell = guideRunner.dwellInfo;
    if (dwell && !done) {
      const left = Math.ceil(dwell.remainingMs / 1000);
      guideStatus.text =
        dwell.mode === "parked"
          ? `$(debug-pause) holding here — Tab for step ${dwell.stepId}`
          : `$(clock) reading — ${left}s to step ${dwell.stepId}`;
      guideStatus.tooltip =
        dwell.mode === "parked"
          ? `The replay is parked on the code you just landed. Tab (or click here) runs step ${dwell.stepId}.`
          : `Holding on the code you just landed. Tab moves on now, Esc stays here for as long as you want.`;
      guideStatus.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      guideStatus.show();
      return;
    }
    // A phase pause must be impossible to miss AFTER the toast is gone: the
    // status bar goes prominent and stays that way until the human continues.
    const paused = guideRunner.pausedPhase;
    if (paused && !done) {
      const short = paused.split(":")[0].trim();
      guideStatus.text = `$(debug-continue) ${short} ready — click to continue`;
      guideStatus.tooltip = `The replay is paused between phases. Click here (or a step in the Replay Guide panel) to start ${paused}.`;
      guideStatus.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      guideStatus.show();
      return;
    }
    // Same treatment for the patch pause: momentum stopped before a whole-file
    // reconcile, and the human must know what it strikes before arming it.
    const patch = guideRunner.pausedPatchInfo;
    if (patch && !done) {
      guideStatus.text = `$(diff) patch of ${patch.rel.split("/").pop()} waiting — click to review`;
      guideStatus.tooltip =
        `The next step reconciles ${patch.rel} with the sandbox: ${patch.detail}. ` +
        `Struck lines can include your own edits — Tab lands the sandbox's bytes, Shift+Esc keeps yours. Click to arm the hunks.`;
      guideStatus.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      guideStatus.show();
      return;
    }
    guideStatus.backgroundColor = undefined;
    guideStatus.text = done
      ? `$(check) Replay: ${guideRunner.feature} ${total}/${total}`
      : `$(debug-step-over) Replay: ${guideRunner.feature} ${at}/${total}`;
    guideStatus.tooltip = done ? "Replay complete" : "Click to run the next replay step";
    guideStatus.show();
  };

  // The dwell has to be visible where the eyes are. A status-bar countdown is
  // not an answer to "why has nothing happened" when the human is reading code
  // three panes away from it. The bytes that just landed get a highlight and
  // the countdown rides on the end of them.
  const dwellDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.selectionHighlightBackground"),
    borderColor: new vscode.ThemeColor("editorInfo.foreground"),
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  context.subscriptions.push(dwellDecoration);
  let dwellPainted = false;
  const renderDwell = () => {
    const info = guideRunner.dwellInfo;
    const target = lastLanded;
    // The common case by far: no dwell, nothing painted. Clearing decorations
    // off every visible editor is a renderer round trip per editor, and
    // `changed()` fires on every step transition — do not pay it for nothing.
    if (!info && !dwellPainted) return;
    dwellPainted = info !== undefined && target !== undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      const mine = info && target && editor.document.uri.toString() === target.uri.toString();
      if (!mine) {
        editor.setDecorations(dwellDecoration, []);
        continue;
      }
      const range = new vscode.Range(
        editor.document.positionAt(target.offset),
        editor.document.positionAt(target.offset + target.length),
      );
      const label =
        info.mode === "parked"
          ? "  held here — Tab for the next step"
          : `  ${Math.ceil(info.remainingMs / 1000)}s — Tab to move on, Esc to stay`;
      editor.setDecorations(dwellDecoration, [
        {
          range,
          renderOptions: {
            after: {
              contentText: label,
              color: new vscode.ThemeColor("editorCodeLens.foreground"),
              fontStyle: "italic",
            },
          },
        },
      ]);
    }
  };

  // The countdown is a status-bar repaint, nothing more: it must not run through
  // the runner's change handler, which persists the position on every fire.
  let dwellTicker: ReturnType<typeof setInterval> | undefined;
  const tickDwell = () => {
    const holding = guideRunner.dwellInfo?.mode === "holding";
    if (holding && !dwellTicker) {
      dwellTicker = setInterval(() => {
        if (guideRunner.dwellInfo?.mode !== "holding") {
          tickDwell();
          return;
        }
        updateGuideStatus();
        renderDwell();
      }, 1000);
    } else if (!holding && dwellTicker) {
      clearInterval(dwellTicker);
      dwellTicker = undefined;
    }
  };
  context.subscriptions.push({
    dispose: () => {
      if (dwellTicker) clearInterval(dwellTicker);
    },
  });

  // Esc while the replay holds: stay on this code. Not a step cancel — the step
  // is landed and done; this only stops the replay moving on.
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.holdHere", () => {
      if (guideRunner.parkDwell()) return;
      vscode.window.setStatusBarMessage(
        guideRunner.dwellInfo
          ? "Human Replay: already holding here — Tab when you are ready"
          : "Human Replay: nothing to hold — the replay is not between steps",
        2000,
      );
    }),
  );

  // The replay-guide panel (TreeView): phases → steps → status. Refreshes whenever
  // the runner's state changes; clicking a step runs it, the inline icons run/skip.
  const guideTree = new GuideTreeProvider(guideRunner);
  // createTreeView, not registerTreeDataProvider: the toast's "Show step" and
  // the gate both reveal a step node the human never expanded, and reveal only
  // exists on the view.
  const guideView = vscode.window.createTreeView("humanReplay.guideSteps", { treeDataProvider: guideTree });
  context.subscriptions.push(guideView);
  const revealStep = (index: number) => {
    void guideView.reveal({ kind: "step", index }, { select: true, focus: false, expand: true });
  };
  guideRunner.setRetrospectiveSurface((retro, index) => surfaceRetrospective(retro, index, output, revealStep));

  // The gate's picker. The runner owns the state machine and the door; this
  // draws it and reports picks back.
  const gatePicker = new GateQuickPick(output, {
    pick: (i) => guideRunner.pickGate(i),
    dismiss: () => guideRunner.dismissGate(),
    flow: () => guideRunner.flowAfterGate(),
    openCode: (step) => void guideRunner.revealStepCode(guideRunner.steps.findIndex((s) => s.id === step.id)),
    openGuide: (step) => {
      if (!currentGuideUri) return;
      const at = new vscode.Position(Math.max(0, step.line - 1), 0);
      void vscode.window.showTextDocument(currentGuideUri, { preview: false, selection: new vscode.Range(at, at) });
    },
  });
  context.subscriptions.push({ dispose: () => gatePicker.dispose() });
  guideRunner.setGateHost(gatePicker);
  guideRunner.setChangeHandler(() => {
    guideTree.refresh();
    updateGuideStatus();
    persistPosition(); // every done/skip lands in workspaceState — a reload resumes here
    void vscode.commands.executeCommand("setContext", "humanReplay.guideLoaded", guideRunner.loaded);
    // While the replay waits before an auto-run Patch step no engine surface is
    // armed, so without this context Tab would fall through to the editor's
    // indent — the stray-indent corruption, on the human's own line. The key
    // lets Tab arm the paused patch instead (the same runNextStep the status
    // bar click runs); arming only discloses hunk 1, so the "see the strike
    // before it lands" gate the pause exists for stays intact.
    void vscode.commands.executeCommand("setContext", "humanReplay.patchPauseActive", guideRunner.pausedPatchInfo !== undefined);
    // The gate's door, as a context key: Tab in the editor re-shows the picker
    // instead of indenting, which is the whole point of a gate the human can Esc
    // out of. Inside the picker itself Tab never reaches the editor at all.
    void vscode.commands.executeCommand("setContext", "humanReplay.gateActive", guideRunner.gateStep !== undefined);
    // Same reason as the patch pause: while the replay holds, no engine surface
    // is armed, so without this key Tab would fall through to the editor's
    // indent and type bytes into the code the human is reading.
    void vscode.commands.executeCommand("setContext", "humanReplay.dwellActive", guideRunner.dwellInfo !== undefined);
    tickDwell();
    renderDwell();
    // Any pause between an accept and the next ghost is human time, not
    // latency. Drop the stopwatch rather than report a gate's think time as a
    // slow ghost.
    if (guideRunner.gateStep || guideRunner.dwellInfo) lastAcceptAt = undefined;
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
      // This fires on Tab whenever `inlineSuggestionVisible` is FALSE while a
      // walk is active — which includes the window where VS Code is still
      // computing the suggestion. A Tab landing there does not accept anything,
      // and until now it left no trace, so a run of dead Tabs read as a clean
      // log and a slow tool. Say it happened.
      output.appendLine("[perf] tab arrived with no inline suggestion visible — nudged instead of accepting");
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
      if (!editor || !(await timed("diffReplayNudge", () => diffReplay.nudge(editor)))) {
        await vscode.commands.executeCommand("tab");
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("humanReplay.guide.runStepAt", async (node?: { index: number }) => {
      if (!node) return;
      await guideRunner.runStep(node.index);
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
    // session/replay-guide.md is the convention; replay-guides/*.md is the
    // legacy location older guides still live in.
    const current = await vscode.workspace.findFiles("session/replay-guide.md");
    if (current.length > 0) return current;
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
    const saved = context.workspaceState.get<{ done?: number[]; skipped?: number[]; gate?: PendingGate }>(positionKey(uri));
    currentGuideUri = undefined;
    const guide = guideRunner.load(md);
    currentGuideUri = uri;
    // Only skips restore from the snapshot — a skip is human intent the bytes can't
    // derive. Done-ness re-derives from ground truth below (resume.ts's thesis):
    // a step reverted out-of-band must fall back to pending, not stay green off a
    // stale counter.
    // A gate the human never answered re-arms across a reload, even though the
    // bytes below will read its step as done — the door was shut when the window
    // went away, so it is shut when the window comes back.
    if (saved?.skipped?.length || saved?.gate) guideRunner.restore({ skipped: saved.skipped, gate: saved.gate });
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const derived = root ? guideRunner.deriveLanded(root) : 0;
    updateGuideStatus();
    // The tree is the replay's control surface — show it the moment a guide
    // loads, or the human never learns it exists. The first step's editor
    // takes keyboard focus right after; the panel stays visible beside it.
    void vscode.commands.executeCommand("humanReplay.guideSteps.focus");
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
        detail: fs.existsSync(path.join(d.full, "session", "replay-guide.md"))
          ? "has session/replay-guide.md"
          : fs.existsSync(path.join(d.full, "replay-guides"))
            ? "has replay-guides/"
            : undefined,
        full: d.full,
      }));
      // The sandbox being resumed is almost always the one you want — pin it first.
      items.sort((a, b) => (a.description ? -1 : 0) - (b.description ? -1 : 0));
      items.push({
        label: "$(file-code) No sandbox — self-contained guide",
        detail: "A guide with embedded Before/After bytes (workspace session/replay-guide.md, replay-guides/, or humanReplay.guidePath)",
      });
      const sandboxPick = await vscode.window.showQuickPick(items, {
        title: "Human Replay: replay from which sandbox?",
        placeHolder: "The sandbox holding the agent's finished work (the After bytes)",
      });
      if (!sandboxPick) return;
      guideRunner.setSandboxRoot(sandboxPick.full);
      output.appendLine(`[replay] sandbox: ${sandboxPick.full ?? "(none — self-contained guide)"}`);

      // The guide lives with the sandbox (the generator writes it there):
      // session/replay-guide.md, with the legacy replay-guides/ folder as the
      // fallback for older sandboxes. Then the workspace's own locations or
      // humanReplay.guidePath for hand-authored guides kept elsewhere; the
      // no-sandbox pick goes straight to those.
      const sandboxGuides = ((): vscode.Uri[] => {
        if (!sandboxPick.full) return [];
        const sessionGuide = path.join(sandboxPick.full, "session", "replay-guide.md");
        if (fs.existsSync(sessionGuide)) return [vscode.Uri.file(sessionGuide)];
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
            ? `Human Replay: no guide at ${sandboxPick.full}/session/replay-guide.md (or legacy replay-guides/) and none in the workspace. Generate one, or set humanReplay.guidePath.`
            : "Human Replay: no replay guide found. Add one at session/replay-guide.md or set humanReplay.guidePath.",
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
      await guideRunner.runCurrent();
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
      await guideRunner.runCurrent();
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

  output.appendLine("[human-replay] activated");
}

export function deactivate() {
  // Nothing to clean up — the provider holds no external resources.
}
