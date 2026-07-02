// Model-free actionability filter for replay notes (the surfacing layer's real gate).
//
// S10's few-shot validation (spikes/S10-comment-prompt) proved live and held-out that
// a local 7B fabricates a task from vague / noise comments no matter how it is
// prompted — the model cannot be talked out of it. So the defense has to be model-free,
// upstream of the call: a comment carrying only "clean it up" / "feels off" / "lol
// classic" has no actionable signal and must never reach the model. This is the S8
// weak-question smell (retrospective.ts) turned on comments.
//
// It is a smell, not a proof: it screens for *signal*, and the human can always
// override (invariant 2 — the human decides). A conflicting pair still passes here, by
// design — each side carries a real constraint, and the model flags the conflict
// correctly (S10 confirmed). What this stops is the all-vague set.

const ACTION_VERB =
  /\b(add|remove|delet|return|guard|rename|replace|use|switch|wrap|cache|memoi[sz]e|stream|validat|split|extract|inline|parallel|sequen|throw|emit|log|retry|handle|prevent|avoid|saturat|bound|limit|encode|decode|serial|deserial|lock|debounce|timeout|panic|truncat)\w*/i;

const SCENARIO =
  /\b(if|when|under|over|overflow|underflow|race|panic|null|none|empty|missing|expire|expires|expiry|skew|concurren|backwards?|hang|hangs|leak|stale|deadlock|drift|forever|never)\b/i;

const IDENTIFIER =
  /`[^`]+`|\b[a-z]+_[a-z]+\b|\b[A-Z][a-z]+[A-Z][a-z]+|::|\b(u|i)(8|16|32|64|128|size)\b|\b(Result|Vec|Option|Duration|Instant|HashMap|BTreeMap|Arc|Mutex)\b/;

const CONCRETE = /\b\d+\s?(s|ms|ns|us|m|h|gb|mb|kb|b|bytes?|%)\b/i;

const VAGUE: RegExp[] = [
  /\b(idk|dunno+|hmm+|meh|lol|lmao|rofl|wtf|tbh|imo)\b/i,
  /\b(feels?|seems?|looks?)\s+(off|wrong|weird|bad|odd)\b/i,
  /\bclean\s*(it|this)?\s*up\b/i,
  /\b(tidy|messy|sloppy|ugly|gross)\b/i,
  /\bcould\s+(probably\s+)?be\s+better\b/i,
  /\b(not\s+sure|unsure)\b/i,
];

/** Higher is more actionable. At or below zero is a smell: too vague to send. */
export function scoreComment(text: string): number {
  let s = 0;
  if (ACTION_VERB.test(text)) s += 1;
  if (SCENARIO.test(text)) s += 1;
  if (IDENTIFIER.test(text)) s += 1;
  if (CONCRETE.test(text)) s += 1;
  if (VAGUE.some((re) => re.test(text))) s -= 2;
  return s;
}

/** A single comment carries enough signal for a model to act faithfully. */
export function isActionable(text: string): boolean {
  return scoreComment(text) > 0;
}

/** Does the note set carry any actionable signal at all? (Set-level pre-gate.) */
export function setIsActionable(texts: string[]): boolean {
  return texts.some(isActionable);
}
