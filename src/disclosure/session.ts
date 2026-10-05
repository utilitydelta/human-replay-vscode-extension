import * as vscode from "vscode";
import { Step } from "./walk";
import { LanguageSpec, RUST } from "./language";
import { Retrospective } from "../retrospective/retrospective";

// One disclosure in flight: the step list, a program counter, and the anchor —
// the absolute document offset where the region begins. cursorOffsets are
// region-relative, so an absolute position is `anchorOffset + cursorOffset`.
// The walk never inserts before the anchor, but the human can: a comment typed
// above the symbol moves every byte of it, so the controller shifts the anchor
// by that edit (shiftAnchor). Without the shift every baked offset lands that
// many bytes early.
//
// `sourceLength` is the disclosed symbol's byte length (the walk reconstructs it
// byte-exact), so the symbol range is [anchorOffset, anchorOffset + sourceLength].
// `retrospective` is the thinking point surfaced when the walk completes.
export class DisclosureSession {
  index = 0;

  constructor(
    readonly uri: vscode.Uri,
    public anchorOffset: number,
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

  // Recovery lands a node whole from its first piece's bareText, so the node's
  // continuation pieces are already in the buffer: step over them.
  advancePastNode(): void {
    this.index++;
    while (this.current()?.continuation) this.index++;
  }

  get done(): boolean {
    return this.index >= this.steps.length;
  }
}
