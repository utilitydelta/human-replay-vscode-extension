import * as vscode from "vscode";
import { GuideRunner, StepStatus } from "./guideRunner";
import { gates, isNoneQuestion, isWeak } from "../retrospective/retrospective";

// The replay-guide panel: a TreeView of phases → steps → status. It is the control
// surface for the program counter and the home for the divergence "blocked" state —
// when a step's anchor is gone the human decides here (skip / jump), never the tool.
//
// It is also where the retrospective LIVES now. The Information squiggle that used
// to carry the question and the invariants is gone (it painted a whole created file
// blue and was ignorable anyway); a step expands instead into its Why, its question
// when no gate is going to ask it, and one node per invariant it touches. The Why
// is the one thing the guide writes for the human rather than the engine, and until
// this it had no surface at all outside a tooltip.
//
// Pure view over GuideRunner: it reads status, never mutates. The runner fires its
// change handler and the tree refreshes. Clicking a step runs it; the inline icons
// run or skip.

export type Node =
  | { kind: "phase"; label: string; steps: number[] }
  | { kind: "step"; index: number }
  | { kind: "why"; index: number }
  | { kind: "question"; index: number }
  | { kind: "invariant"; index: number; at: number }
  | { kind: "checkpoint"; phase: string }
  | { kind: "task"; phase: string; at: number };

const ICON: Record<StepStatus, () => vscode.ThemeIcon> = {
  done: () => new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green")),
  current: () => new vscode.ThemeIcon("debug-stackframe-focused", new vscode.ThemeColor("charts.blue")),
  pending: () => new vscode.ThemeIcon("circle-outline"),
  skipped: () => new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground")),
  blocked: () => new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow")),
};

/** One line, for a tree label: the tree never wraps, so a paragraph would just
 *  truncate mid-word. The full text lives in the tooltip. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export class GuideTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly runner: GuideRunner) {}

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(element?: Node): Node[] {
    if (!this.runner.loaded) return [];
    if (!element) {
      // Group steps by phase, preserving order. Steps with no phase go under "Steps".
      const groups: { label: string; steps: number[] }[] = [];
      this.runner.steps.forEach((s, i) => {
        const label = s.phase ?? "Steps";
        const last = groups[groups.length - 1];
        if (last && last.label === label) last.steps.push(i);
        else groups.push({ label, steps: [i] });
      });
      return groups.map((g) => ({ kind: "phase", label: g.label, steps: g.steps }));
    }
    if (element.kind === "phase") {
      const children: Node[] = element.steps.map((index) => ({ kind: "step", index }));
      // The checkpoint closes the phase, so it sits last — where the replay
      // stops. A phase that wrote none simply has no node.
      if (this.runner.checkpointFor(element.label)) children.push({ kind: "checkpoint", phase: element.label });
      return children;
    }
    if (element.kind === "step") return this.stepChildren(element.index);
    if (element.kind === "checkpoint") {
      const tasks = this.runner.checkpointFor(element.phase)?.tasks ?? [];
      return tasks.map((_, at) => ({ kind: "task", phase: element.phase, at }));
    }
    return [];
  }

  /** The step's own retrospective, unpacked. The question appears only when no
   *  gate is going to ask it — a gated step's question is the gate's title, and
   *  a `none` question was wired off on purpose. */
  private stepChildren(index: number): Node[] {
    const step = this.runner.steps[index];
    if (!step) return [];
    const out: Node[] = [];
    if (step.why.trim()) out.push({ kind: "why", index });
    const q = step.retro.question.trim();
    if (q && !isNoneQuestion(q) && !gates(step.retro)) out.push({ kind: "question", index });
    step.retro.invariants.forEach((_, at) => out.push({ kind: "invariant", index, at }));
    return out;
  }

  /** Reveal needs the chain back to the root — the toast's "Show step" button
   *  and the gate both reveal a step node the human never expanded. */
  getParent(node: Node): Node | undefined {
    if (node.kind === "phase") return undefined;
    if (node.kind === "checkpoint") return this.phaseNode(node.phase);
    if (node.kind === "task") return { kind: "checkpoint", phase: node.phase };
    if (node.kind === "step") return this.phaseNode(this.runner.steps[node.index]?.phase ?? "Steps");
    return { kind: "step", index: node.index };
  }

  private phaseNode(label: string): Node {
    const steps: number[] = [];
    this.runner.steps.forEach((s, i) => {
      if ((s.phase ?? "Steps") === label) steps.push(i);
    });
    return { kind: "phase", label, steps };
  }

  /** The phase's closing checkpoint, and one node per task under it. The tasks
   *  are the human's to run — a tests-before-fix phase asks them to watch the
   *  tests fail and step through them here, in the files they just typed, with
   *  their own runner and debugger. The extension shows the task and gets out
   *  of the way; a test the tool ran for you taught you nothing. Clicking
   *  either node opens the guide at the checkpoint, which is where the
   *  questions (and the answers the panel deliberately withholds) are written.
   */
  private checkpointItem(node: Extract<Node, { kind: "checkpoint" | "task" }>): vscode.TreeItem {
    const check = this.runner.checkpointFor(node.phase);
    const tasks = check?.tasks ?? [];
    const open: vscode.Command | undefined = check
      ? { command: "humanReplay.guide.openCheckpoint", title: "Open the checkpoint in the guide", arguments: [check.line] }
      : undefined;
    if (node.kind === "task") {
      const text = tasks[node.at] ?? "";
      const item = new vscode.TreeItem(oneLine(text), vscode.TreeItemCollapsibleState.None);
      item.id = `task:${node.phase}:${node.at}`;
      item.iconPath = new vscode.ThemeIcon("circle-outline");
      item.tooltip = new vscode.MarkdownString(text);
      item.contextValue = "guideTask";
      if (open) item.command = open;
      return item;
    }
    // Waiting is the state worth colouring: the replay has stopped on this
    // boundary, and the phase behind the door is the one that turns these green.
    const waiting = this.runner.pausedCheckpoint?.phase === node.phase;
    const item = new vscode.TreeItem(
      "Checkpoint",
      tasks.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : waiting
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `checkpoint:${node.phase}`;
    item.iconPath = new vscode.ThemeIcon("checklist", waiting ? new vscode.ThemeColor("charts.yellow") : undefined);
    item.description = waiting ? "run these yourself before the next phase" : tasks.length === 1 ? "1 check" : `${tasks.length} checks`;
    item.tooltip = new vscode.MarkdownString(
      tasks.length === 0
        ? "**Checkpoint**\n\nNo checklist items — open the guide to read it."
        : `**Checkpoint**\n\n${tasks.map((t) => `- ${t}`).join("\n")}`,
    );
    item.contextValue = "guideCheckpoint";
    if (open) item.command = open;
    return item;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "phase") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `phase:${node.label}`;
      item.contextValue = "guidePhase";
      return item;
    }
    if (node.kind === "checkpoint" || node.kind === "task") return this.checkpointItem(node);
    const step = this.runner.steps[node.index];
    if (node.kind === "step") {
      const status = this.runner.status(node.index);
      const hasChildren = this.stepChildren(node.index).length > 0;
      // Expanded on the step the human is on, collapsed everywhere else: the
      // retrospective is for the step in hand, not a wall of every step's Why.
      const collapsed = !hasChildren
        ? vscode.TreeItemCollapsibleState.None
        : status === "current"
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
      const item = new vscode.TreeItem(`${step.id}: ${step.title}`, collapsed);
      item.id = `step:${node.index}`;
      item.description = `${step.action} ${step.symbol}`;
      item.iconPath = ICON[status]();
      item.contextValue = "guideStep";
      item.tooltip = status === "blocked" ? "Target position changed — run, skip, or jump" : step.why || step.title;
      // Click runs this step. (Carries the index for the run/skip commands.)
      item.command = { command: "humanReplay.guide.runStepAt", title: "Run step", arguments: [node] };
      return item;
    }
    if (node.kind === "why") {
      const item = new vscode.TreeItem(oneLine(step.why), vscode.TreeItemCollapsibleState.None);
      item.id = `why:${node.index}`;
      item.iconPath = new vscode.ThemeIcon("lightbulb");
      item.tooltip = new vscode.MarkdownString(`**Why**\n\n${step.why}`);
      item.contextValue = "guideWhy";
      return item;
    }
    if (node.kind === "question") {
      const q = step.retro.question;
      const weak = isWeak(q);
      const item = new vscode.TreeItem(oneLine(q), vscode.TreeItemCollapsibleState.None);
      item.id = `question:${node.index}`;
      item.iconPath = new vscode.ThemeIcon(weak ? "warning" : "question");
      // A weak question is a smell about the AGENT that wrote the guide, not
      // about the human: it could not say why this code exists, so this step is
      // the one to read harder — not the one to skim.
      item.description = weak ? "weak question — read this step harder" : "retrospective";
      item.tooltip = new vscode.MarkdownString(
        weak
          ? `**Retrospective (weak)**\n\n${q}\n\nThe guide could not say specifically why this code exists. Read the step harder than the question asks.`
          : `**Retrospective**\n\n${q}`,
      );
      item.contextValue = "guideQuestion";
      return item;
    }
    const inv = step.retro.invariants[node.at];
    const item = new vscode.TreeItem(inv.rule, vscode.TreeItemCollapsibleState.None);
    item.id = `invariant:${node.index}:${node.at}`;
    item.iconPath = new vscode.ThemeIcon("shield");
    item.description = "invariant";
    item.tooltip = new vscode.MarkdownString(`**${inv.rule}**\n\n${inv.reason}`);
    item.contextValue = "guideInvariant";
    return item;
  }
}
