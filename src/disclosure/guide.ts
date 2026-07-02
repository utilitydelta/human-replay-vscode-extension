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

import { Invariant, Retrospective } from "../retrospective/retrospective";

// "create-file" discloses a brand-new file via the file walk (fileWalk.ts):
// one gesture per blank-line group of top-level items, the full descend-and-fill
// walk inside bare functions. Unfenced, the step is the whole sandbox file —
// the engine owns the gesture cut, the author owns the teaching cut. A file
// with more than one teaching moment (an error type, a helper, the engine)
// instead embeds an After fence carrying only the file's SKELETON (header,
// usings, frame); the remaining symbols arrive as ordinary create steps, each
// with its own Why and retrospective.
export type StepAction = "create" | "modify" | "delete" | "create-file" | "patch";

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
}

export interface ReplayGuide {
  /** The feature slug from `# Replay: {slug}`. */
  feature: string;
  /** System invariants declared once, in play across the whole guide. */
  invariants: Invariant[];
  /** Steps in replay (dependency) order — the program counter walks these. */
  steps: ReplayStep[];
}

const FIELD = /^\*\*([^*]+):\*\*\s?(.*)$/; // **Label:** value
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```/;
const STEP_HEADING = /^Step\s+([\d.]+):\s*(.*)$/i;
const INVARIANT_BULLET = /^[-*]\s+\*\*([^*]+?):?\*\*\s*:?\s*(.*)$/; // - **Rule:** reason

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

function parseFields(lines: string[]): FieldBag {
  const fields = new Map<string, string>();
  let before: string | undefined;
  let after: string | undefined;
  let lastLabel: string | null = null; // last text field, for continuation
  let codeTarget: "before" | "after" | null = null; // last Before/After label

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE.test(line)) {
      // Capture verbatim to the closing fence — ground truth, no normalization.
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      const code = body.join("\n");
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
      } else if (label === "after") {
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
    default:
      throw new Error(`replay guide: step has unknown or missing **Action:** "${raw ?? ""}"`);
  }
}

// Split the document into sections keyed by their heading line, preserving the
// body lines under each. The order of headings is preserved.
interface Section {
  level: number;
  title: string;
  body: string[];
}

function splitSections(md: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of md.split("\n")) {
    const h = HEADING.exec(line);
    if (h) {
      current = { level: h[1].length, title: h[2].trim(), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return sections;
}

/**
 * Parse a canonical replay guide into the ordered steps the engine replays.
 * Throws on a malformed guide (missing feature, dangling invariant reference,
 * unknown action, a modify/create/delete step missing the bytes it needs) —
 * the guide is canonical, so a defect is loud, not silently tolerated.
 */
export function parseGuide(md: string): ReplayGuide {
  const sections = splitSections(md);

  const titleSection = sections.find((s) => s.level === 1 && /^Replay:/i.test(s.title));
  if (!titleSection) throw new Error("replay guide: missing `# Replay: {feature}` heading");
  const feature = titleSection.title.replace(/^Replay:\s*/i, "").trim();

  const invSection = sections.find((s) => /^System Invariants$/i.test(s.title));
  const invMap = invSection ? parseInvariants(invSection.body) : new Map<string, Invariant>();

  const steps: ReplayStep[] = [];
  let currentPhase: string | undefined;
  for (const s of sections) {
    if (s.level === 2 && /^Phase\b/i.test(s.title)) {
      currentPhase = s.title;
      continue;
    }
    const sm = STEP_HEADING.exec(s.title);
    if (!sm) continue;
    const id = sm[1];
    const title = sm[2].trim();
    const bag = parseFields(s.body);

    const action = parseAction(bag.fields.get("action"));
    const file = (bag.fields.get("file") ?? "").replace(/`/g, "").trim();

    // A step needs the symbol bytes its action drives (create → after, delete →
    // before, modify → both). They may be embedded as Before/After fences, or — for
    // a lean guide — resolved at replay from the symbol + file (the runner reads
    // `before` from the target workspace and `after` from the sandbox). So a missing
    // fence is not a parse error; it just means "resolve from files", and that needs
    // a File. A create-file step always resolves from the sandbox file.
    const missingFence =
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
      (action === "create-file" || action === "patch" ? file.split(":")[0] : "");
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

    const retro: Retrospective = {
      symbol,
      question: bag.fields.get("retrospective") ?? "",
      invariants,
    };

    steps.push({
      id,
      title,
      phase: currentPhase,
      file,
      action,
      symbol,
      why: bag.fields.get("why") ?? "",
      retro,
      before: bag.before,
      after: bag.after,
    });
  }

  if (steps.length === 0) throw new Error("replay guide: no `### Step N.M:` steps found");
  return { feature, invariants: [...invMap.values()], steps };
}
