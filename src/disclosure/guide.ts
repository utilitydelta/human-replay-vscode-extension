// Replay-guide ingestion. Parses a canonical replay guide (markdown) into the
// ordered steps the engine drives — turning the tool from a fixture demo into the
// real guide-driven thing.
//
// The guide is canonical (invariant 3): the source of truth the engine replays,
// not the sandbox git history. It is self-contained and model-free — each step
// carries the real sandbox bytes (the before/after fences), so disclosure projects
// ground truth (invariant 1) with no inference on the parse or the replay.
//
// What the guide carries per step: the symbol, the diff (before/after fences), the
// action, the why, the retrospective question, and the invariant tags. System
// invariants are declared once at the top; each step references them by rule name
// and the parser resolves the full rule+reason. A dangling reference is a guide
// bug, not a soft failure — the parser throws, because the guide is canonical.

import { Invariant, RetroChoice, Retrospective } from "../retrospective/retrospective";

// "create-file" discloses a brand-new file via the file walk (fileWalk.ts):
// one gesture per blank-line group of top-level items, the full descend-and-fill
// walk inside bare functions. Unfenced, the step is the whole sandbox file —
// the engine owns the gesture cut, the author owns the teaching cut. A file
// with more than one teaching moment (an error type, a helper, the engine)
// instead embeds an After fence carrying only the file's SKELETON (header,
// usings, frame); the remaining symbols arrive as ordinary create steps, each
// with its own Why and retrospective.
//
// Three actions type nothing. "read" shows code the human reads but does not
// type: the caller view of an outside-in unit, or a contract page. "comment"
// pauses for the human to write their own comments in a file they just typed,
// with the guide's drafted stage table shown beside it. "rule" prints a
// decision recap and waits for the human to pick an option by name.
export type StepAction = "create" | "modify" | "delete" | "create-file" | "patch" | "read" | "comment" | "rule";

/** Actions that land bytes in the target. The rest pause the replay. */
export function typesBytes(action: StepAction): boolean {
  return action !== "read" && action !== "comment" && action !== "rule";
}

/** A `rule` step's ballot: the decision it rules and the names the human picks from. */
export interface Ruling {
  /** The id of the call being ruled: the project's own (e.g. "ADR-012") or a slug the guide makes up. */
  decision: string;
  /** The names the human picks from, in guide order: "yes | no", "A | B". */
  options: string[];
  /** The option the guide recommends, when it names one. Never preselected. */
  recommend: string | undefined;
}

export interface ReplayStep {
  /** Step id from the heading, e.g. "1.1". The program counter indexes the array. */
  id: string;
  /** The heading title after the id. */
  title: string;
  /** The `## Phase N: ...` heading this step falls under, for the panel grouping. */
  phase: string | undefined;
  /** File the symbol lives in, with optional `:line` for the human's ctrl-click. */
  file: string;
  /** Create (disclose new), modify (diff-replay), or delete (strike). */
  action: StepAction;
  /** The symbol this step builds — the semantic anchor, not a line number. */
  symbol: string;
  /** Why this code exists — the design the human reads, not the code. */
  why: string;
  /** The retrospective that gates this step: question + invariants in play. */
  retro: Retrospective;
  /** Real branch bytes the change starts from. Absent for create. */
  before?: string;
  /** Real sandbox bytes the change lands. Absent for delete. */
  after?: string;
  /** 1-based line of this step's `### Step N.M:` heading in the guide, so the
   *  gate's "open the guide here" lands on the step and not the top of a
   *  thousand-line file. */
  line: number;
  /** Tests this step expects red when it lands (a test step written against shells). */
  red: string[];
  /** Tests this step turns green (an internals step). */
  green: string[];
  /** Present on a `rule` step only. */
  ruling?: Ruling;
}

/** What a unit delivers. A component unit builds one component outside in and
 *  ends green: types, shells, red tests, the caller view, then the bodies that
 *  turn the tests green, all in one phase. `contract` and `internals` are the
 *  older split of that across two phases, which leaves a phase ending red.
 *  A closing unit revisits a module the human already typed; a delta unit
 *  carries a change to code already replayed. */
export type UnitKind = "component" | "contract" | "internals" | "closing" | "delta";

/** A phase that declares `**Unit:**` under its heading. Every phase is a replay
 *  unit to the validator's budget; the declared kind adds the order checks. */
export interface ReplayUnit {
  /** The `## Phase N: ...` heading. */
  phase: string;
  line: number;
  kind: UnitKind;
  /** The one module the unit builds, from `**Module:**`, when declared. */
  module: string | undefined;
  /** How its shells answer before the internals land, from `**Shells:**`.
   *  `throw` (the default): the language's own not-implemented marker
   *  (`todo!()`, `throw new NotImplementedException()`, `raise
   *  NotImplementedError`). `no-throw`: for code that bans panics, an empty
   *  answer, a named refusal, or a temporary `Unbuilt`. */
  shells: "throw" | "no-throw";
}

// A phase's closing `### CHECKPOINT: ...` block. The replay already stops at
// every phase boundary; until this, the stop said nothing but "review what
// landed". The guide author wrote the actionable part here — most sharply for a
// tests-before-fix phase, whose checkpoint names the command and the failures
// the human must SEE before the fix turns them green.
//
// Only the `- [ ]` task lines are carried. The checkpoint's other bullets are
// questions with their answers inline one blockquote below, and surfacing those
// in a panel hands over the answer before the human has thought about it. Those
// stay in the markdown, which the human opens from the node.
export interface PhaseCheckpoint {
  /** The `## Phase N: ...` heading this checkpoint closes. */
  phase: string;
  /** 1-based line of the `### CHECKPOINT:` heading, for opening the guide here. */
  line: number;
  /** The block's `- [ ]` items, in order, marker stripped and wrapping joined. */
  tasks: string[];
}

export interface ReplayGuide {
  /** The feature slug from `# Replay: {slug}`. */
  feature: string;
  /** System invariants declared once, in play across the whole guide. */
  invariants: Invariant[];
  /** Steps in replay (dependency) order — the program counter walks these. */
  steps: ReplayStep[];
  /** Phase checkpoints, keyed by the phase heading they close. Empty when the
   *  guide writes none — a checkpoint is optional, a step is not. */
  checkpoints: PhaseCheckpoint[];
  /** Phases that declared a `**Unit:**` kind, in guide order. */
  units: ReplayUnit[];
}

const FIELD = /^\*\*([^*]+):\*\*\s?(.*)$/; // **Label:** value
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(`{3,})/; // the run length: a ```` block closes on ````, not on the ``` inside it
const STEP_HEADING = /^Step\s+([\d.]+):\s*(.*)$/i;
const INVARIANT_BULLET = /^[-*]\s+\*\*([^*]+?):?\*\*\s*:?\s*(.*)$/; // - **Rule:** reason
const QUOTE = /^\s*>\s?(.*?)\s*$/; // a blockquote line, body captured (CRLF safe)
const CHOICE = /^\*\*(Answer|Distractor):\*\*\s*(.*)$/i; // inside the blockquote
const CHECKPOINT_HEADING = /^CHECKPOINT\b:?\s*(.*)$/i;
// `- [ ]` only. A ticked `- [x]` is not carried: the panel counts what it holds
// and calls it outstanding, so an item the human already ticked would be a
// number that lies at them. Dropping it makes the list shrink as they work.
const TASK = /^[-*]\s+\[ \]\s+(.*)$/; // - [ ] run this yourself

// Parse `**Label:**`-prefixed lines into a field bag. A value runs from after its
// colon across continuation lines until the next field, heading, fence, or blank
// line — so a wrapped "Why" stays whole while single-line fields stay tight.
// Fenced code blocks are captured verbatim (byte-exact) against the most recent
// Before/After label. Returns the lowercased-label bag plus before/after code.
interface FieldBag {
  fields: Map<string, string>;
  before?: string;
  after?: string;
}

function parseFields(lines: string[], eol: string): FieldBag {
  const fields = new Map<string, string>();
  let before: string | undefined;
  let after: string | undefined;
  let lastLabel: string | null = null; // last text field, for continuation
  let codeTarget: "before" | "after" | null = null; // last Before/After label

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const open = FENCE.exec(line);
    if (open) {
      // Capture verbatim to the closing fence — ground truth, no normalization.
      // The close must be at least as long as the open, so a ```` block that
      // wraps a ``` one (a step whose After is itself a markdown file with a
      // code block) captures the inner fence as content instead of ending on it.
      const ticks = open[1].length;
      const body: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        const close = FENCE.exec(lines[i]);
        if (close && close[1].length >= ticks) break;
        body.push(lines[i]);
      }
      const code = body.join(eol);
      if (codeTarget === "before") before = code;
      else if (codeTarget === "after") after = code;
      lastLabel = null;
      continue;
    }

    const fm = FIELD.exec(line);
    if (fm) {
      const label = fm[1].trim().toLowerCase();
      const value = fm[2].trim();
      if (label === "before") {
        codeTarget = "before";
        lastLabel = null;
      } else if (label === "after" || label === "shows") {
        // `**Shows:**` is the same fence under the name a read or comment step
        // means: code to read, or the drafted stage table beside a comment pause.
        codeTarget = "after";
        lastLabel = null;
      } else {
        fields.set(label, value);
        lastLabel = label;
        codeTarget = null;
      }
      continue;
    }

    if (HEADING.test(line)) {
      lastLabel = null;
      codeTarget = null;
      continue;
    }

    if (line.trim() === "") {
      lastLabel = null; // a blank line ends a wrapped value
      continue;
    }

    // The choice blockquote is its own reader's territory. It ends a wrapped
    // value the way a blank line does, so an answer written tight under the
    // question never lands inside the question text.
    if (QUOTE.test(line)) {
      lastLabel = null;
      codeTarget = null;
      continue;
    }

    // Continuation of the current text field (e.g. a wrapped Why).
    if (lastLabel) {
      fields.set(lastLabel, `${fields.get(lastLabel)} ${line.trim()}`.trim());
    }
  }

  return { fields, before, after };
}

// Parse the `## System Invariants` section into a rule→reason map. Each bullet is
// `- **Rule:** reason`; steps reference these by rule name.
function parseInvariants(lines: string[]): Map<string, Invariant> {
  const out = new Map<string, Invariant>();
  for (const line of lines) {
    const m = INVARIANT_BULLET.exec(line.trim());
    if (!m) continue;
    const rule = m[1].trim();
    out.set(rule.toLowerCase(), { rule, reason: m[2].trim() });
  }
  return out;
}


// Read a step's answer key: the `> **Answer:** / > **Distractor:**` blockquote
// under its question. The block is scoped to the step's own section and the run
// stops at the first non-`>` line, so a Before fence below it (or the next
// step's block) can never bleed in; the reader does not depend on a blank line
// separating it from the question. An unlabelled `> ` line joins the previous
// choice with a space — 29 answers in the corpus already wrap, and a wrapped
// continuation must not read as a fourth choice.
//
// The count is a hard contract, not a preference (invariant 3, fail loud):
// answer plus exactly two distractors gates the step; nothing at all leaves the
// step ungated and every legacy guide loadable; anything between is a guide bug
// the author fixes now rather than a lopsided picker the human meets later.
function parseChoices(lines: string[], stepId: string): RetroChoice[] {
  const run: string[] = [];
  let inRun = false;
  let fence = 0; // backtick count of the open fence, 0 when outside one
  for (const line of lines) {
    // A fenced block is verbatim bytes (a markdown step's After can itself hold
    // a blockquote) — never answer-key territory. Fences nest by length: a
    // ```` block closes on ```` and not on the ``` inside it.
    const ticks = /^(`{3,})/.exec(line);
    if (ticks) {
      if (fence === 0) fence = ticks[1].length;
      else if (ticks[1].length >= fence) fence = 0;
      continue;
    }
    if (fence > 0) continue;
    const q = QUOTE.exec(line);
    if (q) {
      run.push(q[1]);
      inRun = true;
      continue;
    }
    // The first run carrying a labelled choice is the answer key; a decorative
    // blockquote before it is not.
    if (inRun) {
      if (run.some((l) => CHOICE.test(l.trim()))) break;
      run.length = 0;
      inRun = false;
    }
  }

  const choices: RetroChoice[] = [];
  for (const raw of run) {
    const body = raw.trim();
    const m = CHOICE.exec(body);
    if (m) {
      choices.push({ text: m[2].trim(), correct: m[1].toLowerCase() === "answer" });
      continue;
    }
    if (body === "") continue;
    // A wrapped continuation. With no choice open there is nothing to join —
    // a prose blockquote above the key, which the reader ignores.
    const last = choices[choices.length - 1];
    if (last) last.text = `${last.text} ${body}`.trim();
  }

  if (choices.length === 0) return [];
  const answers = choices.filter((c) => c.correct).length;
  const distractors = choices.length - answers;
  if (answers !== 1) {
    throw new Error(
      `replay guide: step ${stepId} has ${answers} \`> **Answer:**\` line(s) in its retrospective block — exactly one is required`,
    );
  }
  if (distractors !== 0 && distractors !== 2) {
    throw new Error(
      `replay guide: step ${stepId} has ${distractors} \`> **Distractor:**\` line(s) — a step gates on exactly two, or carries none and stays ungated`,
    );
  }
  if (distractors === 0) return [];
  // Answer first, then the distractors in document order. The gate shuffles;
  // the parser keeps the guide's order so a diff of the parse reads like the file.
  return [...choices.filter((c) => c.correct), ...choices.filter((c) => !c.correct)];
}

function parseUnitKind(raw: string, phase: string): UnitKind {
  const kind = raw.replace(/`/g, "").trim().toLowerCase();
  if (kind === "component" || kind === "contract" || kind === "internals" || kind === "closing" || kind === "delta") return kind;
  throw new Error(`replay guide: "${phase}" declares unknown **Unit:** "${raw}" — component, closing or delta (or contract, internals)`);
}

/** A comma-separated name list, backticks stripped: `**Red:** \`a\`, b`. */
function nameList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((n) => n.replace(/`/g, "").trim())
    .filter((n) => n.length > 0);
}

// A rule step that cannot be ruled is a guide bug the human would meet as a
// picker with one row, or a recommendation that is not on it.
function parseRuling(fields: Map<string, string>, stepId: string): Ruling {
  const decision = (fields.get("decision") ?? "").replace(/`/g, "").trim();
  if (!decision) throw new Error(`replay guide: rule step ${stepId} has no **Decision:**`);
  const options = (fields.get("options") ?? "")
    .split("|")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (options.length < 2) {
    throw new Error(`replay guide: rule step ${stepId} needs at least two **Options:** separated by "|"`);
  }
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
    throw new Error(`replay guide: rule step ${stepId} repeats an option — a pick must name exactly one`);
  }
  const rawRecommend = fields.get("recommend")?.trim();
  const recommend = rawRecommend ? options.find((o) => o.toLowerCase() === rawRecommend.toLowerCase()) : undefined;
  if (rawRecommend && recommend === undefined) {
    throw new Error(`replay guide: rule step ${stepId} recommends "${rawRecommend}", which is not one of its options`);
  }
  return { decision, options, recommend };
}

function parseAction(raw: string | undefined): StepAction {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "create":
      return "create";
    case "modify":
      return "modify";
    case "delete":
      return "delete";
    case "create file":
    case "create-file":
      return "create-file";
    case "patch":
      return "patch";
    case "read":
      return "read";
    case "comment":
      return "comment";
    case "rule":
      return "rule";
    default:
      throw new Error(`replay guide: step has unknown or missing **Action:** "${raw ?? ""}"`);
  }
}

// Split the document into sections keyed by their heading line, preserving the
// body lines under each. The order of headings is preserved.
interface Section {
  level: number;
  title: string;
  /** 1-based line of the heading in the guide — the step's "open here". */
  line: number;
  body: string[];
}

function splitSections(md: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  // Split on either terminator and carry no carriage returns into the line
  // regexes: JS `.` never matches \r, so a guide saved with CRLF matched no
  // heading, no field and no fence — it did not parse at all.
  //
  // Fences are opaque here. A step's Before/After can be a markdown file, and
  // its `# Heading` lines are BYTES, not structure: reading them as headings
  // ended the step at its own fence and truncated the bytes it was carrying.
  let fence = 0; // backtick run length of the open fence, 0 when outside one
  md.split(/\r?\n/).forEach((line, i) => {
    const ticks = FENCE.exec(line);
    if (ticks) {
      if (fence === 0) fence = ticks[1].length;
      else if (ticks[1].length >= fence) fence = 0;
      if (current) current.body.push(line);
      return;
    }
    const h = fence === 0 ? HEADING.exec(line) : null;
    if (h) {
      current = { level: h[1].length, title: h[2].trim(), line: i + 1, body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  });
  // An unclosed fence swallows every heading below it, so the steps after it
  // would simply not exist — the human replays half a feature and never learns
  // the other half was there. The guide is canonical: say so and stop.
  if (fence > 0) throw new Error("replay guide: unclosed code fence — every step below it would be swallowed");
  return sections;
}

/** The `- [ ]` lines of a checkpoint block, wrapping joined. A task runs from its
 *  marker until the next bullet, a blank line, or a `**Label:**` — guides wrap
 *  prose the same way everywhere, so this is the field bag's rule again. */
function parseTasks(body: string[]): string[] {
  const tasks: string[] = [];
  let open: string[] = [];
  let fence = 0; // backtick run length of the open fence, 0 when outside one
  const close = () => {
    if (open.length > 0) tasks.push(open.join(" ").replace(/\s+/g, " ").trim());
    open = [];
  };
  for (const raw of body) {
    const line = raw.trim();
    // Fenced bytes in a checkpoint are a sample: the failure output the human
    // should expect, or a guide-format snippet. Sample output contains lines
    // that start `- [ ]`, and without this they were promoted to instructions
    // the author never wrote. The fence also ends the task it sits under rather
    // than folding its backticks into the string the toast renders.
    const ticks = FENCE.exec(line);
    if (ticks) {
      if (fence === 0) fence = ticks[1].length;
      else if (ticks[1].length >= fence) fence = 0;
      close();
      continue;
    }
    if (fence > 0) continue;
    const t = TASK.exec(line);
    if (t) {
      close();
      open = [t[1]];
      continue;
    }
    if (open.length === 0) continue;
    // A `>` line is the answer key the guide writes beside its questions. It
    // ends the task and is never carried: the panel renders these strings, and
    // an answer on a panel is an answer handed over before the human has
    // thought about the question.
    if (line === "" || line.startsWith(">") || FIELD.test(line) || /^[-*]\s/.test(line)) close();
    else open.push(line);
  }
  close();
  return tasks;
}

/**
 * Parse a canonical replay guide into the ordered steps the engine replays.
 * Throws on a malformed guide (missing feature, dangling invariant reference,
 * unknown action, a modify/create/delete step missing the bytes it needs) —
 * the guide is canonical, so a defect is loud, not silently tolerated.
 */
export function parseGuide(md: string): ReplayGuide {
  // The guide's own line terminator, so a fenced block reconstructs with the
  // bytes the guide carries rather than being normalized to LF.
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const sections = splitSections(md);

  const titleSection = sections.find((s) => s.level === 1 && /^Replay:/i.test(s.title));
  if (!titleSection) throw new Error("replay guide: missing `# Replay: {feature}` heading");
  const feature = titleSection.title.replace(/^Replay:\s*/i, "").trim();

  const invSection = sections.find((s) => /^System Invariants$/i.test(s.title));
  const invMap = invSection ? parseInvariants(invSection.body) : new Map<string, Invariant>();

  const steps: ReplayStep[] = [];
  const checkpoints: PhaseCheckpoint[] = [];
  const units: ReplayUnit[] = [];
  let currentPhase: string | undefined;
  for (const s of sections) {
    if (s.level === 2 && /^Phase\b/i.test(s.title)) {
      currentPhase = s.title;
      const phaseFields = parseFields(s.body, eol).fields;
      const unit = phaseFields.get("unit");
      if (unit !== undefined) {
        const module = phaseFields.get("module")?.replace(/`/g, "").trim();
        const shells = /no-?throw/i.test(phaseFields.get("shells") ?? "") ? "no-throw" : "throw";
        units.push({ phase: s.title, line: s.line, kind: parseUnitKind(unit, s.title), module: module || undefined, shells });
      }
      continue;
    }
    if (CHECKPOINT_HEADING.test(s.title)) {
      // Keyed by phase, not by position: the runner looks it up when that
      // phase's last step resolves. "Steps" matches the tree's fallback for a
      // guide that never declares a phase.
      const phase = currentPhase ?? "Steps";
      // Every consumer resolves a phase to one checkpoint, so a second one is
      // tasks the human would never see. A `### CHECKPOINT:` under `## Closing`
      // lands here too, because only a `## Phase` heading moves the key. The
      // guide is canonical: say which phase, and stop.
      if (checkpoints.some((c) => c.phase === phase)) {
        throw new Error(`replay guide: two checkpoints under "${phase}" — the second one's tasks would never reach the human`);
      }
      checkpoints.push({ phase, line: s.line, tasks: parseTasks(s.body) });
      continue;
    }
    const sm = STEP_HEADING.exec(s.title);
    if (!sm) continue;
    const id = sm[1];
    const title = sm[2].trim();
    const bag = parseFields(s.body, eol);

    const action = parseAction(bag.fields.get("action"));
    const file = (bag.fields.get("file") ?? "").replace(/`/g, "").trim();

    // A step needs the symbol bytes its action drives (create → after, delete →
    // before, modify → both). They may be embedded as Before/After fences, or — for
    // a lean guide — resolved at replay from the symbol + file (the runner reads
    // `before` from the target workspace and `after` from the sandbox). So a missing
    // fence is not a parse error; it just means "resolve from files", and that needs
    // a File. A create-file step always resolves from the sandbox file.
    const ruling = action === "rule" ? parseRuling(bag.fields, id) : undefined;

    // A rule step reads no file. A read step can carry its code as a fence (a
    // caller kept outside both trees); a comment step always names its file.
    const missingFence =
      action === "rule"
        ? false
        : action === "read"
          ? bag.after === undefined
          : action === "comment" ||
            action === "create-file" ||
            action === "patch" ||
            (action !== "create" && bag.before === undefined) ||
            (action !== "delete" && bag.after === undefined);
    if (missingFence && !file) {
      throw new Error(`replay guide: step ${id} (${action}) has no Before/After fence and no **File:** to resolve bytes from`);
    }

    // A whole-file step (create-file, patch) has no symbol to anchor on — the
    // file IS the unit; label it by the file so the panel and retrospective read
    // naturally.
    const symbol =
      (bag.fields.get("symbol") ?? "").replace(/^`|`$/g, "").trim() ||
      (action === "rule" ? (ruling?.decision ?? "") : "") ||
      (action === "create-file" || action === "patch" || action === "read" || action === "comment" ? file.split(":")[0] : "");
    if (!symbol) throw new Error(`replay guide: step ${id} missing **Symbol:**`);

    // Resolve referenced invariants from the declared set. A dangling reference
    // is a guide bug — fail loud (invariant 3: the guide is canonical).
    const refs = (bag.fields.get("invariants") ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0 && !/^none/i.test(r));
    const invariants: Invariant[] = refs.map((ref) => {
      const inv = invMap.get(ref.toLowerCase());
      if (!inv) throw new Error(`replay guide: step ${id} references unknown invariant "${ref}"`);
      return inv;
    });

    const why = bag.fields.get("why") ?? "";
    const retro: Retrospective = {
      symbol,
      question: bag.fields.get("retrospective") ?? "",
      why,
      invariants,
      choices: parseChoices(s.body, id),
    };

    steps.push({
      id,
      title,
      phase: currentPhase,
      file,
      action,
      symbol,
      why,
      retro,
      before: bag.before,
      after: bag.after,
      line: s.line,
      red: nameList(bag.fields.get("red")),
      green: nameList(bag.fields.get("green")),
      ...(ruling ? { ruling } : {}),
    });
  }

  if (steps.length === 0) throw new Error("replay guide: no `### Step N.M:` steps found");
  return { feature, invariants: [...invMap.values()], steps, checkpoints, units };
}
