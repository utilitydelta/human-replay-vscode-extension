// The dwell: the beat between a step landing and the replay jumping to the next
// one. Pure state machine, injected clock, no vscode.
//
// The problem it solves. Momentum was instant: the last Tab of a step landed and
// the runner opened the next step's file, parked the cursor and armed a ghost in
// the same turn. Often that is a different function in a different file, so the
// bytes you just read scroll out of the window before you have read them. The
// replay is supposed to be the thing you understand, not the thing that outruns
// you.
//
// Three states, and the second one is why this is a machine and not a sleep:
//
//   holding — the clock is running. It elapses on its own into the next step.
//   parked  — the human pressed Esc. The clock is dead and nothing moves until
//             they ask. Still ARMED, because a parked replay with no armed
//             surface means Tab falls through to the editor's indent, which is
//             the stray-byte corruption this repo keeps re-learning.
//   off     — no dwell pending.
//
// The invariant worth the file: the next step runs exactly once. A timer that
// fires after the human already tabbed past it would run the step twice, on a
// buffer the first run is already editing.

export type DwellMode = "holding" | "parked";

/** Opaque handle for whatever the host uses to schedule (a Node/DOM timer). */
export type DwellTimer = unknown;

export interface DwellClock {
  now(): number;
  after(ms: number, fn: () => void): DwellTimer;
  cancel(timer: DwellTimer): void;
}

export interface DwellInfo {
  mode: DwellMode;
  /** The step index the dwell is holding in front of. */
  next: number;
  /** Milliseconds left on the clock. Always 0 when parked. */
  remainingMs: number;
}

export class DwellGate {
  private state: { next: number; endsAt: number; mode: DwellMode; timer: DwellTimer | undefined } | undefined;

  constructor(
    private readonly clock: DwellClock,
    /** Fires when the clock runs out on its own. Never fires for a gesture. */
    private readonly onElapse: (next: number) => void,
  ) {}

  /** Hold in front of step `next` for `ms`. A zero or negative hold is not a
   *  dwell at all: the caller runs the step itself. */
  hold(next: number, ms: number): boolean {
    this.clear();
    if (ms <= 0) return false;
    const timer = this.clock.after(ms, () => {
      // Read the state through `take` so an elapse can never fire on a dwell
      // the human already resolved. The timer may already be in flight when
      // Tab lands; this is the race that would otherwise run the step twice.
      const at = this.take();
      if (at !== undefined) this.onElapse(at);
    });
    this.state = { next, endsAt: this.clock.now() + ms, mode: "holding", timer };
    return true;
  }

  /** Esc: stop the clock and stay put. The dwell stays armed so the next
   *  gesture still has somewhere to go and Tab still means "continue". */
  park(): boolean {
    const s = this.state;
    if (!s || s.mode === "parked") return false;
    if (s.timer !== undefined) this.clock.cancel(s.timer);
    this.state = { ...s, mode: "parked", timer: undefined, endsAt: this.clock.now() };
    return true;
  }

  /** A run gesture (Tab, the status bar, a tree click). Hands back the step the
   *  dwell was holding and disarms, so the caller runs it. Returns undefined
   *  when no dwell is pending, which is how the double-fire is closed. */
  take(): number | undefined {
    const s = this.state;
    if (!s) return undefined;
    if (s.timer !== undefined) this.clock.cancel(s.timer);
    this.state = undefined;
    return s.next;
  }

  /** Drop the dwell without running anything: cancel, skip, unload, resync. */
  clear(): void {
    const s = this.state;
    if (!s) return;
    if (s.timer !== undefined) this.clock.cancel(s.timer);
    this.state = undefined;
  }

  get info(): DwellInfo | undefined {
    const s = this.state;
    if (!s) return undefined;
    return {
      mode: s.mode,
      next: s.next,
      remainingMs: s.mode === "parked" ? 0 : Math.max(0, s.endsAt - this.clock.now()),
    };
  }
}
