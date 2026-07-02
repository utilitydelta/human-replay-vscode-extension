import * as vscode from "vscode";
import { Step } from "./walk";
import { LanguageSpec, RUST } from "./language";
import { Retrospective } from "../retrospective/retrospective";

// One disclosure in flight: the step list, a program counter, and the anchor —
// the absolute document offset where the region begins. cursorOffsets are
// region-relative, so an absolute position is `anchorOffset + cursorOffset`.
// Nothing inserts before the anchor, so it stays fixed for the whole walk.
//
// `sourceLength` is the disclosed symbol's byte length (the walk reconstructs it
// byte-exact), so the symbol range is [anchorOffset, anchorOffset + sourceLength].
// `retrospective` is the thinking point surfaced when the walk completes.
export class DisclosureSession {
  index = 0;

  constructor(
    readonly uri: vscode.Uri,
    readonly anchorOffset: number,
    readonly steps: Step[],
    readonly sourceLength: number,
    readonly retrospective?: Retrospective,
    readonly spec: LanguageSpec = RUST,
  ) {}

  current(): Step | undefined {
    return this.steps[this.index];
  }

  advance(): void {
    this.index++;
  }

  get done(): boolean {
    return this.index >= this.steps.length;
  }
}
