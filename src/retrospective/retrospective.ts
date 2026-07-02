// The retrospective that gates a disclosed step, plus the weak-question smell.
//
// A step ends at a thinking point: the guide decided this is where the human
// should stop and answer for what they just read. Two things ride on it. The
// invariants the step touches are surfaced verbatim (the safety axis). And the
// question itself is scored: a generic question ("does this make sense?") means
// the agent that wrote the guide could not say why its own code existed here, so
// that step gets MORE attention, not less. The smell is a confidence probe on the
// agent, not a comprehension probe we trust. Ported from spike S8 (P/R 1.00).

export interface Invariant {
  /** The rule, stated as the methodology states it ("single writer"). */
  rule: string;
  /** Why it holds and what breaks without it. */
  reason: string;
}

export interface Retrospective {
  /** The symbol this gates, for display. */
  symbol: string;
  /** The question the human answers before moving on. */
  question: string;
  /** System Invariants this step touches, surfaced verbatim. */
  invariants: Invariant[];
}

const GENERIC = [
  /make sense/i, /edge cases?\??$/i, /performant/i, /does this (code )?work/i,
  /any improvements?/i, /is this correct/i, /anything wrong/i, /look(s)? good/i,
  /right approach/i, /any issues/i,
];

const hasIdentifier = (q: string) =>
  /`[^`]+`/.test(q) || // backticked symbol
  /\b[a-z]+_[a-z]+\b/.test(q) || // snake_case
  /\b[A-Z][a-z]+[A-Z][a-z]+/.test(q) || // CamelCase
  /::/.test(q);

const hasScenario = (q: string) =>
  /\b(if|when|under|past|before|after|during|expires?|drift\w*|fails?|unavailable|concurrent|race|timeout|overflow|empty|missing|behind|mid-?\w+)\b/i.test(
    q,
  );

const hasAlternative = (q: string) =>
  /(instead of|rather than|\bvs\b|, or )/i.test(q);

/** Higher is more specific. A weak question scores at or below zero. */
export function scoreQuestion(q: string): number {
  let s = 0;
  if (hasIdentifier(q)) s += 1;
  if (hasScenario(q)) s += 1;
  if (hasAlternative(q)) s += 1;
  if (q.split(/\s+/).length >= 12) s += 1; // specific questions tend to be longer
  if (GENERIC.some((re) => re.test(q))) s -= 2;
  return s;
}

/** A weak (generic) question is a smell: read that step harder. */
export function isWeak(q: string): boolean {
  return scoreQuestion(q) <= 0;
}
