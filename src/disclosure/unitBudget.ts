// The replay-unit budget and the outside-in order checks the validator runs.
//
// A unit is one sitting: 30 to 60 minutes. Units that size landed in one go;
// 20-phase guides of several hundred steps did not. So every phase is a unit,
// and the validator refuses one past the budget rather than letting the human
// find out an hour in. The numbers are the budget's, not measurements of this
// code: 25 steps, 150 typed lines, 4 new types.
//
// Pure: the validator resolves bytes and hands each step's added lines in.

import { ReplayStep, ReplayUnit, typesBytes } from "./guide";

export interface UnitBudget {
  maxSteps: number;
  maxTypedLines: number;
  maxNewTypes: number;
}

export const UNIT_BUDGET: UnitBudget = { maxSteps: 25, maxTypedLines: 150, maxNewTypes: 4 };

/** One step as the budget sees it: the non-blank lines it adds to the target. */
export interface StepCost {
  step: ReplayStep;
  addedLines: string[];
}

export interface UnitMeasure {
  phase: string;
  steps: number;
  typedLines: number;
  newTypes: string[];
  /** Typed non-test files outside the unit's declared module. */
  outsideModule: string[];
}

export interface UnitVerdict {
  errors: string[];
  warnings: string[];
}

// A type declaration at the start of an added line, per file extension. Line
// based on purpose: the count is a budget, and an associated `type` inside an
// impl is indented, so it does not read as a new type.
const TYPE_DECL: [RegExp, RegExp][] = [
  [/\.rs$/, /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union|trait|type)\s+([A-Za-z_]\w*)/],
  [/\.cs$/, /^\s*(?:(?:public|internal|private|protected|sealed|abstract|static|readonly|partial|record)\s+)*(?:class|struct|interface|enum|record)\s+([A-Za-z_]\w*)/],
  [/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/],
  [/\.py$/, /^class\s+([A-Za-z_]\w*)/],
];

/** Names of the types these added lines declare. */
export function newTypeNames(file: string, lines: string[]): string[] {
  const rule = TYPE_DECL.find(([ext]) => ext.test(file));
  if (!rule) return [];
  const names: string[] = [];
  for (const line of lines) {
    const m = rule[1].exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/** A test file by its path: tests ride with the unit wherever the language keeps them. */
export function isTestFile(file: string): boolean {
  return /(^|[/\\])(tests?|__tests__|spec)[/\\]|[._-](test|tests|spec)\.[^/\\]+$|(^|[/\\])test_[^/\\]+$/i.test(file);
}

const CODE_FILE = /\.(rs|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/i;

/** Where a phase's tests sit relative to its code. Tests travel with the code
 *  they test: a phase of tests alone means the code shipped untested phases
 *  ago, and a phase of code with no test leaves its commit unproven. */
export function testPlacement(steps: ReplayStep[]): { testsOnly: boolean; untested: boolean } {
  const typed = steps.filter((s) => typesBytes(s.action));
  const isTest = (s: ReplayStep) => isTestFile(rel(s.file)) || s.red.length > 0;
  const code = typed.filter((s) => CODE_FILE.test(rel(s.file)) && !isTest(s));
  const tests = typed.filter(isTest);
  return {
    testsOnly: code.length === 0 && tests.length > 0,
    untested: code.length > 0 && tests.length === 0 && !typed.some((s) => s.green.length > 0),
  };
}

function rel(file: string): string {
  return file.split(":")[0].replace(/^\.\//, "");
}

function underModule(file: string, module: string): boolean {
  const m = module.replace(/^\.\//, "").replace(/\/+$/, "");
  const f = rel(file);
  // A module is a file or a directory: `src/log` owns `src/log.rs` and `src/log/*`.
  return f === m || f.startsWith(`${m}/`) || f.replace(/\.[^./]+$/, "") === m;
}

export function measureUnit(phase: string, module: string | undefined, costs: StepCost[]): UnitMeasure {
  const outside = new Set<string>();
  let typedLines = 0;
  const newTypes: string[] = [];
  for (const { step, addedLines } of costs) {
    if (!typesBytes(step.action)) continue;
    typedLines += addedLines.length;
    newTypes.push(...newTypeNames(rel(step.file), addedLines));
    if (module && !isTestFile(step.file) && !underModule(step.file, module)) outside.add(rel(step.file));
  }
  return { phase, steps: costs.length, typedLines, newTypes, outsideModule: [...outside] };
}

/** Why this unit is over budget; empty when it fits. */
export function overBudget(m: UnitMeasure, budget: UnitBudget = UNIT_BUDGET): string[] {
  const out: string[] = [];
  if (m.steps > budget.maxSteps) out.push(`${m.steps} steps (max ${budget.maxSteps})`);
  if (m.typedLines > budget.maxTypedLines) out.push(`${m.typedLines} typed lines (max ${budget.maxTypedLines})`);
  if (m.newTypes.length > budget.maxNewTypes) {
    out.push(`${m.newTypes.length} new types: ${m.newTypes.join(", ")} (max ${budget.maxNewTypes})`);
  }
  return out;
}

// A shell that panics turns every red test into a crash, and the human learns
// nothing from a crash they could not have predicted. Rust and C# spellings.
// The not-implemented markers of each supported language: Rust's panicking
// macros, C#'s NotImplementedException, Python's NotImplementedError, and a
// TS/JS `throw new Error("not implemented")`.
const SHELL_PANIC =
  /\b(todo!|unimplemented!|panic!|unreachable!)\s*\(|throw\s+new\s+NotImplementedException|raise\s+NotImplementedError|throw\s+new\s+Error\(\s*["'`]not implemented/i;

/** Added lines in a contract unit that panic instead of answering. */
export function shellPanics(costs: StepCost[]): { step: string; line: string }[] {
  const out: { step: string; line: string }[] = [];
  for (const { step, addedLines } of costs) {
    if (!typesBytes(step.action)) continue;
    for (const line of addedLines) if (SHELL_PANIC.test(line)) out.push({ step: step.id, line: line.trim() });
  }
  return out;
}

/** The order a declared unit kind promises. Steps are the unit's, in guide order. */
export function unitOrderProblems(unit: ReplayUnit, steps: ReplayStep[]): UnitVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const typed = steps.filter((s) => typesBytes(s.action));
  const firstTyped = steps.findIndex((s) => typesBytes(s.action));
  // The contract page closes a closing unit after the comment pause, so a
  // Markdown page does not count as code the comments must follow.
  const isCode = (s: ReplayStep) => typesBytes(s.action) && !/\.md$/i.test(rel(s.file));
  const lastTyped = steps.reduce((at, s, i) => (isCode(s) ? i : at), -1);
  if (unit.kind === "contract") {
    const firstRed = steps.findIndex((s) => s.red.length > 0);
    if (firstRed < 0) errors.push("contract unit names no red test (`**Red:**`): the walkthrough and edge tests go red against the shells here");
    const firstGreen = steps.find((s) => s.green.length > 0);
    if (firstGreen) errors.push(`step ${firstGreen.id} turns tests green inside a contract unit: bodies belong to the internals unit`);
    const caller = steps.findIndex((s) => s.action === "read");
    if (caller < 0) warnings.push("contract unit has no read step: no caller view (fine only when no caller exists yet)");
    else if (firstRed >= 0 && caller < firstRed) warnings.push(`caller view (step ${steps[caller].id}) comes before the red tests`);
  }
  if (unit.kind === "component") {
    const firstRed = steps.findIndex((s) => s.red.length > 0);
    if (firstRed < 0) errors.push("component unit names no red test (`**Red:**`): its tests go red against the shells before the bodies land");
    const caller = steps.findIndex((s) => s.action === "read");
    if (caller >= 0 && firstRed >= 0 && caller < firstRed) warnings.push(`caller view (step ${steps[caller].id}) comes before the red tests`);
    steps.forEach((s, i) => {
      if (firstRed < 0 || i <= firstRed) return;
      if ((s.action === "create" || s.action === "modify") && s.red.length === 0 && s.green.length === 0 && !isTestFile(s.file) && CODE_FILE.test(rel(s.file))) {
        warnings.push(`step ${s.id} adds code after the red tests and names no test it turns green (\`**Green:**\`)`);
      }
    });
  }
  if (unit.kind === "internals") {
    for (const s of typed) {
      if ((s.action === "create" || s.action === "modify") && s.green.length === 0 && !isTestFile(s.file)) {
        warnings.push(`step ${s.id} names no test it turns green (\`**Green:**\`)`);
      }
    }
  }
  if (unit.kind === "closing") {
    const rules = steps.map((s, i) => [s, i] as const).filter(([s]) => s.action === "rule");
    const comments = steps.map((s, i) => [s, i] as const).filter(([s]) => s.action === "comment");
    // The grill is rule steps on the calls the module rests on and read steps
    // on the edge cases it fails under; a project with no decision log may
    // have only the second kind.
    const grillEnd = firstTyped >= 0 ? firstTyped : steps.length;
    const grilled = steps.slice(0, grillEnd).some((s) => s.action === "rule" || s.action === "read");
    if (!grilled) errors.push("closing unit opens with no grill: a rule or read step before the first typed step");
    if (comments.length === 0) errors.push("closing unit has no comment step: the human layer is the point of the pass");
    for (const [s, i] of rules) {
      if (firstTyped >= 0 && i > firstTyped) errors.push(`rule step ${s.id} comes after typed step ${steps[firstTyped].id}: the grill opens the unit`);
    }
    for (const [s, i] of comments) {
      if (firstTyped >= 0 && i < lastTyped) errors.push(`comment step ${s.id} comes before typed step ${steps[lastTyped].id}: comments go on the code as it ends`);
    }
    const last = steps[steps.length - 1];
    if (last && last.action !== "read" && !(last.action === "create-file" && /\.md$/i.test(rel(last.file)))) {
      warnings.push(`closing unit ends on step ${last.id}, not a contract page (a read step or a Markdown create file)`);
    }
  }
  return { errors, warnings };
}

/** Red and green across the guide: a green with no red is a typo or a test
 *  from another guide; a red never greened waits on a later guide. */
/** Every phase ends green: a test marked red turns green in the same phase,
 *  so the human can stop and commit at any phase boundary. */
export function redGreenProblems(steps: ReplayStep[]): UnitVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const red = new Map<string, { id: string; phase: string }>();
  const greened = new Set<string>();
  for (const s of steps) {
    const phase = s.phase ?? "Steps";
    for (const t of s.red) {
      if (red.has(t)) errors.push(`test \`${t}\` marked red at step ${s.id} and again at step ${red.get(t)!.id}`);
      else red.set(t, { id: s.id, phase });
    }
    for (const t of s.green) {
      const r = red.get(t);
      if (!r) warnings.push(`step ${s.id} turns \`${t}\` green, but no earlier step in this guide marks it red`);
      else if (r.phase !== phase) errors.push(`test \`${t}\` goes red in ${r.phase} and green only in ${phase}: a phase ends green`);
      if (greened.has(t)) errors.push(`test \`${t}\` turned green twice (again at step ${s.id})`);
      greened.add(t);
    }
  }
  for (const [t, r] of red) if (!greened.has(t)) errors.push(`test \`${t}\` (red at step ${r.id}) never turns green: ${r.phase} ends red`);
  return { errors, warnings };
}

/** Files that still name the temporary `Unbuilt` refusal once every step has run. */
export function unbuiltSurvivors(files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of files) if (/\bUnbuilt\b/.test(text)) out.push(file);
  return out;
}
