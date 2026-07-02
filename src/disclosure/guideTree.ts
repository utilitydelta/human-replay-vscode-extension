import * as vscode from "vscode";
import { GuideRunner, StepStatus } from "./guideRunner";

// The replay-guide panel: a TreeView of phases → steps → status. It is the control
// surface for the program counter and the home for the divergence "blocked" state —
// when a step's anchor is gone the human decides here (skip / jump), never the tool.
//
// Pure view over GuideRunner: it reads status, never mutates. The runner fires its
// change handler and the tree refreshes. Clicking a step runs it; the inline icons
// run or skip.

type Node = { kind: "phase"; label: string; steps: number[] } | { kind: "step"; index: number };

const ICON: Record<StepStatus, () => vscode.ThemeIcon> = {
  done: () => new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green")),
  current: () => new vscode.ThemeIcon("debug-stackframe-focused", new vscode.ThemeColor("charts.blue")),
  pending: () => new vscode.ThemeIcon("circle-outline"),
  skipped: () => new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground")),
  blocked: () => new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow")),
};

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
    if (element.kind === "phase") return element.steps.map((index) => ({ kind: "step", index }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "phase") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = "guidePhase";
      return item;
    }
    const step = this.runner.steps[node.index];
    const status = this.runner.status(node.index);
    const item = new vscode.TreeItem(`${step.id}: ${step.title}`, vscode.TreeItemCollapsibleState.None);
    item.description = `${step.action} ${step.symbol}`;
    item.iconPath = ICON[status]();
    item.contextValue = "guideStep";
    item.tooltip = status === "blocked" ? "Target position changed — run, skip, or jump" : step.why || step.title;
    // Click runs this step. (Carries the index for the run/skip commands.)
    item.command = { command: "humanReplay.guide.runStepAt", title: "Run step", arguments: [node] };
    return item;
  }
}
