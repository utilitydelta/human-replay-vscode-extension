// The replay program counter — pure state, no VS Code, so it can be tested headless.
//
// A single integer can't represent the real shape of a replay: the human may jump
// to step 5, skip step 2, hit a blocked step. Done/skipped/blocked are explicit
// sets; "current" is the in-flight walk or, when nothing is walking, the next step
// still to run. This is what the panel renders and what advances when a walk
// completes (not when it starts — walks are interactive).

export type StepStatus = "done" | "current" | "pending" | "skipped" | "blocked";

export class ProgramCounter {
  private done = new Set<number>();
  private skipped = new Set<number>();
  private blocked = new Set<number>();
  private inFlight: number | undefined; // the step whose walk is interactively running

  constructor(private total = 0) {}

  reset(total: number): void {
    this.total = total;
    this.done.clear();
    this.skipped.clear();
    this.blocked.clear();
    this.inFlight = undefined;
  }

  /** Start walking step `i` (clears any block on it; the walk advances on complete). */
  begin(i: number): void {
    this.inFlight = i;
    this.blocked.delete(i);
  }

  /** The in-flight walk finished — mark it done. Returns false if nothing was flying. */
  complete(): boolean {
    if (this.inFlight === undefined) return false;
    this.done.add(this.inFlight);
    this.inFlight = undefined;
    return true;
  }

  /** The in-flight walk was cancelled — nothing landed. The step keeps its prior
   *  mark and position falls back to next(), so a stray completion event after
   *  the cancel can't mark the step done. */
  cancelInFlight(): boolean {
    if (this.inFlight === undefined) return false;
    this.inFlight = undefined;
    return true;
  }

  /** The in-flight walk hit a collision — mark it blocked (the human decides). */
  block(): boolean {
    if (this.inFlight === undefined) return false;
    this.blocked.add(this.inFlight);
    this.inFlight = undefined;
    return true;
  }

  /** Skip step `i` — it won't count as done, and "next" steps past it. */
  skip(i: number): void {
    this.skipped.add(i);
    this.blocked.delete(i);
    if (this.inFlight === i) this.inFlight = undefined;
  }

  /** Mark step `i` done without a walk — resume derived it from the files, or a
   *  persisted session recorded it. Out-of-range indices are ignored (a stale
   *  snapshot against a re-edited guide must not corrupt the counter). */
  markDone(i: number): void {
    if (i < 0 || i >= this.total) return;
    this.done.add(i);
    this.skipped.delete(i);
    this.blocked.delete(i);
    if (this.inFlight === i) this.inFlight = undefined;
  }

  /** The persistable position: done + skipped. Blocked/in-flight are live-session
   *  states — a reload resolves them by re-deriving from the files. */
  snapshot(): { done: number[]; skipped: number[] } {
    return { done: [...this.done].sort((a, b) => a - b), skipped: [...this.skipped].sort((a, b) => a - b) };
  }

  /** Merge a snapshot in (union — never un-does live progress). */
  restore(s: { done?: number[]; skipped?: number[] }): void {
    for (const i of s.done ?? []) this.markDone(i);
    for (const i of s.skipped ?? []) if (i >= 0 && i < this.total && !this.done.has(i)) this.skip(i);
  }

  /** First step neither done nor skipped — the next to run (== total when none left). */
  next(): number {
    for (let i = 0; i < this.total; i++) if (!this.done.has(i) && !this.skipped.has(i)) return i;
    return this.total;
  }

  /** The step the panel highlights: the in-flight walk, else the next to run. */
  position(): number {
    return this.inFlight ?? this.next();
  }

  status(i: number): StepStatus {
    if (this.blocked.has(i)) return "blocked";
    if (this.done.has(i)) return "done";
    if (this.skipped.has(i)) return "skipped";
    if (i === this.position() && i < this.total) return "current";
    return "pending";
  }

  get inFlightIndex(): number | undefined {
    return this.inFlight;
  }
  get completedCount(): number {
    return this.done.size;
  }
  /** Every step is resolved (done or skipped) and nothing is mid-flight. */
  get isComplete(): boolean {
    return this.inFlight === undefined && this.next() === this.total && this.total > 0;
  }
}
