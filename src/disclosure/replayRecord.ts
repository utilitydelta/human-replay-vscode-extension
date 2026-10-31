// What the replay writes down for whoever reads it after: the rulings the human
// picked by name, and when each unit started and stopped. Both are JSON lines,
// one event per line, appended and never rewritten, so a bot or a script reads
// them with nothing but a line split.
//
//   rulings.jsonl     {"decision","choice","options","recommended","guide","unit","step","at","by"}
//   unit-times.jsonl  {"event":"start"|"stop"|"comment", "unit", "guide", "at", "by", ...}
//
// A team replays concurrently and commits these files. Every line stands alone
// and carries who wrote it (`by`) and when (`at`), so a union merge of two
// branches is correct whatever order the lines land in: readers sort by `at`.
// The record folder carries a .gitattributes asking git for that union merge.
//
// The extension records a pick; it never writes a ledger. What a pick means
// (confirmed, overturned) is the reading project's call.
//
// Pure: the extension owns the files and the clock, this owns the shapes.

export interface RulingRecord {
  decision: string;
  choice: string;
  options: string[];
  recommended: string | null;
  guide: string;
  unit: string | null;
  step: string;
  at: string;
}

export type UnitEvent =
  | { event: "start"; unit: string; guide: string; at: string }
  | { event: "stop"; unit: string; guide: string; at: string; steps: number; done: number; reason: StopReason }
  | { event: "comment"; unit: string; guide: string; at: string; step: string; file: string; changed: boolean };

/** Why a unit's clock stopped: its last step resolved, or the sitting ended mid-unit. */
export type StopReason = "unit-complete" | "left-unit" | "session-ended";

/** One record as one line. `by` is who replayed: the git user, else the OS user. */
export function jsonLine(record: RulingRecord | UnitEvent, by?: string): string {
  return `${JSON.stringify(by === undefined ? record : { ...record, by })}\n`;
}

/** The record folder's .gitattributes: git merges both sides' lines instead of conflicting. */
export const RECORD_GITATTRIBUTES = "*.jsonl merge=union\n";

// The unit clock. A unit starts the first time one of its steps runs in this
// sitting and stops when the replay leaves it: at the phase boundary, when a
// step in another unit is run, or when the session ends. A reload mid-unit
// writes a stop and a fresh start, so time away from the editor between
// sittings never counts as replay time.
export class UnitClock {
  private open: { unit: string; startedAt: number } | undefined;

  constructor(
    private readonly guide: string,
    private readonly now: () => number,
  ) {}

  get current(): string | undefined {
    return this.open?.unit;
  }

  /** A step in `unit` is about to run. Returns the events to append. */
  enter(unit: string, progress: (unit: string) => { steps: number; done: number }): UnitEvent[] {
    if (this.open?.unit === unit) return [];
    const events = this.leave("left-unit", progress);
    const at = this.now();
    this.open = { unit, startedAt: at };
    events.push({ event: "start", unit, guide: this.guide, at: new Date(at).toISOString() });
    return events;
  }

  /** The replay left the open unit. Nothing to write when none is open. */
  leave(reason: StopReason, progress: (unit: string) => { steps: number; done: number }): UnitEvent[] {
    const open = this.open;
    if (!open) return [];
    this.open = undefined;
    const { steps, done } = progress(open.unit);
    return [{ event: "stop", unit: open.unit, guide: this.guide, at: new Date(this.now()).toISOString(), steps, done, reason }];
  }
}

/** A step as the record reader needs it. */
export interface RecordedStep {
  id: string;
  action: string;
  ruling?: { decision: string };
}

function lines(text: string | undefined): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of (text ?? "").split("\n")) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // a torn or hand-edited line says nothing about done-ness
    }
  }
  return out;
}

/** The steps that type nothing which the record shows this person already did.
 *  A rule step is done when `me` picked its decision at that step of this guide;
 *  a comment step when its pause closed; a read step when anything after it is
 *  done, since reading is the one act the record cannot show. `typedDone` are
 *  the typed steps the files show landed. Lines without `by` count as anyone's. */
export function recordedPauseDone(
  steps: RecordedStep[],
  feature: string,
  me: string,
  rulings: string | undefined,
  units: string | undefined,
  typedDone: number[],
): number[] {
  const mine = (r: Record<string, unknown>) => r.guide === feature && (r.by === undefined || r.by === me);
  const picked = new Set(lines(rulings).filter(mine).map((r) => `${r.step}|${r.decision}`));
  const commented = new Set(lines(units).filter((r) => mine(r) && r.event === "comment").map((r) => String(r.step)));
  const done = new Set<number>();
  steps.forEach((s, i) => {
    if (s.action === "rule" && s.ruling && picked.has(`${s.id}|${s.ruling.decision}`)) done.add(i);
    if (s.action === "comment" && commented.has(s.id)) done.add(i);
  });
  const last = Math.max(-1, ...typedDone, ...done);
  steps.forEach((s, i) => {
    if (s.action === "read" && i < last) done.add(i);
  });
  return [...done].sort((a, b) => a - b);
}
