// Finding the sandbox for a guide that names none. A session folder in some
// other repo holds the guide; the agent's finished tree is somewhere else on
// disk. The bytes say where: a tree is the sandbox when every step that reads
// its After bytes from the sandbox resolves there. One tree proven: use it.
// Several, or none: the human picks. Model-free, and no guess either way.

import * as fs from "fs";
import * as path from "path";
import { ReplayStep, typesBytes } from "./guide";
import { languageForFile } from "./language";
import { extractSymbol } from "./resume";

export interface ProbeFs {
  /** File text, or undefined when missing or unreadable. */
  readFile(absPath: string): string | undefined;
  /** Names (not paths) of the entries directly in a folder; [] when missing. */
  listFiles(absDir: string): string[];
  /** Absolute paths of the child folders of a folder; [] when missing. */
  listDirs(absDir: string): string[];
  /** The path with symlinks resolved; the path itself when it can't be. Absent: no symlinks. */
  realPath?(absPath: string): string;
}

const GUIDE_NAME = /^replay-guide(\..+)?\.md$/;

/** Guide files at the top level of a session folder, `replay-guide.md` first. */
export function sessionGuides(dir: string, fsx: ProbeFs): string[] {
  return fsx
    .listFiles(dir)
    .filter((name) => GUIDE_NAME.test(name))
    .sort((a, b) => (a === "replay-guide.md" ? -1 : b === "replay-guide.md" ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map((name) => path.join(dir, name));
}

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** The folders to probe: the session folder, its ancestors, extra, workspace
 *  siblings, sandboxParent children. Symlinks resolve first, so the target
 *  never slips in under another name. */
export function candidateRoots(
  input: { sessionDir: string; workspaceRoot: string; stopAt: string; sandboxParent?: string; extra: string[] },
  fsx: ProbeFs,
): string[] {
  const real = (p: string) => (fsx.realPath ? fsx.realPath(path.resolve(p)) : path.resolve(p));
  const workspace = real(input.workspaceRoot);
  const stopAt = real(input.stopAt);
  const session = real(input.sessionDir);
  const ancestors: string[] = [];
  for (let dir = path.dirname(session); !inside(stopAt, dir); dir = path.dirname(dir)) {
    ancestors.push(dir);
  }
  const ordered = [
    session,
    ...ancestors,
    ...input.extra,
    ...fsx.listDirs(path.dirname(workspace)),
    ...(input.sandboxParent ? fsx.listDirs(input.sandboxParent) : []),
  ].map(real);
  return [...new Set(ordered)].filter((p) => !inside(p, workspace));
}

export interface ProbeResult {
  root: string;
  resolved: number;
  total: number;
  missing: string[];
}

const sandboxSourced = (step: ReplayStep): boolean =>
  typesBytes(step.action) && step.action !== "delete" && step.after === undefined;

/** How many of the guide's sandbox-sourced steps resolve from root. */
export function probeSandbox(steps: ReplayStep[], root: string, fsx: ProbeFs): ProbeResult {
  const texts = new Map<string, string | undefined>();
  const read = (rel: string) => {
    if (!texts.has(rel)) texts.set(rel, fsx.readFile(path.join(root, rel)));
    return texts.get(rel);
  };
  const sourced = steps.filter(sandboxSourced);
  const missing = sourced
    .filter((step) => {
      const rel = step.file.split(":")[0];
      const text = read(rel);
      if (text === undefined) return true;
      if (step.action === "create-file" || step.action === "patch") return false;
      const spec = languageForFile(rel);
      return spec !== undefined && extractSymbol(text, step.symbol, spec) === undefined;
    })
    .map((step) => step.id);
  return { root, resolved: sourced.length - missing.length, total: sourced.length, missing };
}

export type SandboxVerdict =
  | { kind: "not-needed" }
  | { kind: "unique"; pick: ProbeResult; ranked: ProbeResult[] }
  | { kind: "ambiguous"; ranked: ProbeResult[] }
  /** Folders hold every step, but none holds a byte the target lacks: a copy
   *  of the target, or a target that already landed everything. */
  | { kind: "unproven"; ranked: ProbeResult[] }
  | { kind: "none"; ranked: ProbeResult[] };

// The bytes one step reads from a tree: the named item, or the whole file.
function stepBytes(step: ReplayStep, root: string, fsx: ProbeFs): string | undefined {
  const rel = step.file.split(":")[0];
  const text = fsx.readFile(path.join(root, rel));
  if (text === undefined || step.action === "create-file" || step.action === "patch") return text;
  const spec = languageForFile(rel);
  return spec ? extractSymbol(text, step.symbol, spec) : text;
}

// A tree that resolves every step proves nothing if a copy of the target does
// too. It is the sandbox only when it holds a byte no copy of the base could:
// a created item or file the target lacks or holds differently, or a deleted
// item the target still holds. A modify or patch never witnesses: with no
// base bytes to hand, "the edit the agent made" and "the edit the human
// already landed" read the same against the target.
export function witnessed(steps: ReplayStep[], root: string, fsx: ProbeFs, workspaceRoot: string | undefined): boolean {
  const target = (step: ReplayStep) => (workspaceRoot === undefined ? undefined : stepBytes(step, workspaceRoot, fsx));
  return steps.some((step) => {
    if (step.action === "delete") {
      const spec = languageForFile(step.file.split(":")[0]);
      return spec !== undefined && target(step) !== undefined && stepBytes(step, root, fsx) === undefined;
    }
    if (!sandboxSourced(step) || step.action === "modify" || step.action === "patch") return false;
    return stepBytes(step, root, fsx) !== target(step);
  });
}

/** Probe every candidate and say whether the bytes prove exactly one.
 *  `workspaceRoot` is the target: a candidate is proven only by a byte that
 *  differs from it. */
export function rankSandboxes(steps: ReplayStep[], candidates: string[], fsx: ProbeFs, workspaceRoot?: string): SandboxVerdict {
  if (!steps.some(sandboxSourced)) return { kind: "not-needed" };
  const ranked = candidates
    .map((root) => probeSandbox(steps, root, fsx))
    .filter((r) => r.resolved > 0)
    .sort((a, b) => b.resolved - a.resolved);
  const full = ranked.filter((r) => r.resolved === r.total);
  const proven = full.filter((r) => witnessed(steps, r.root, fsx, workspaceRoot));
  if (proven.length === 1) return { kind: "unique", pick: proven[0], ranked };
  if (proven.length > 1) return { kind: "ambiguous", ranked };
  return full.length > 0 ? { kind: "unproven", ranked } : { kind: "none", ranked };
}

/** The real disk, for the extension. */
export const diskProbeFs: ProbeFs = {
  readFile(absPath) {
    try {
      return fs.readFileSync(absPath, "utf8");
    } catch {
      return undefined;
    }
  },
  listFiles(absDir) {
    try {
      return fs.readdirSync(absDir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
    } catch {
      return [];
    }
  },
  realPath(absPath) {
    try {
      return fs.realpathSync(absPath);
    } catch {
      return absPath;
    }
  },
  listDirs(absDir) {
    try {
      return fs
        .readdirSync(absDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => path.join(absDir, d.name));
    } catch {
      return [];
    }
  },
};
