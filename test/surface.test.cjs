// Oracle for the extension's contributed surface after the model layer and the
// replay-notes layer are removed (package.json + the file listing).
//
// The invariant: Human Replay is the deterministic guide replay and nothing
// else. No local-model FIM autocomplete (Ollama client, prompt templates,
// completion postprocess, model pull, note weave, model settings) and no
// inline-comment notes layer (collation, comments-to-prompt generation, its
// actionability gate, its semantic anchoring). What survives is the hero path:
// load a guide, route steps, insert walk, diff replay, patch steps, the Replay
// Guide tree, and the Tab keybindings that drive them. The retrospective layer
// stays; it is guide-authored, model-free content.
//
// Black box on purpose. This file reads the manifest and the file listing only,
// never src/ internals, so it pins the contract rather than the implementation.
// src/extension.ts is not bundled here: it imports `vscode`, which does not
// resolve headless.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const MANIFEST_TEXT = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
const pkg = JSON.parse(MANIFEST_TEXT);

const contributes = pkg.contributes || {};
const commandIds = (contributes.commands || []).map((c) => c.command);
const configProps = (contributes.configuration || {}).properties || {};
const configKeys = Object.keys(configProps);
const keybindings = contributes.keybindings || [];

// ---------------------------------------------------------------------------
// The line: what goes, what stays.
// ---------------------------------------------------------------------------

// Model layer (FIM autocomplete) and notes layer (comment capture, prompt gen).
const REMOVED_COMMANDS = [
  "humanReplay.toggle", // "Toggle Autocomplete": the model layer's opt-in gate
  "humanReplay.startOllama",
  "humanReplay.chooseModel",
  "humanReplay.reviveAutocomplete", // status-bar "autocomplete offline" click handler
  "humanReplay.comments.add",
  "humanReplay.comments.pullPrompt",
  "humanReplay.comments.clear",
  "humanReplay.comments.nextBlock",
];

// Every command that drives the replay. Judgement calls all landed here:
// continueDisclosure, resync and skipHunk are recovery gestures on the
// deterministic path, not model or notes surface.
const KEPT_COMMANDS = [
  "humanReplay.startReplay",
  "humanReplay.runNextStep",
  "humanReplay.cancelDisclosure",
  "humanReplay.endReplay",
  "humanReplay.resync",
  "humanReplay.skipHunk",
  "humanReplay.continueDisclosure",
  "humanReplay.guide.runStepAt",
  "humanReplay.guide.skipStepAt",
];

const REMOVED_CONFIG = [
  "humanReplay.enabled", // "enable local FIM autocomplete"
  "humanReplay.apiBase",
  "humanReplay.model",
  "humanReplay.promptModel",
  "humanReplay.template",
  "humanReplay.maxTokens",
  "humanReplay.temperature",
  "humanReplay.debounceMs",
  "humanReplay.prefixChars",
  "humanReplay.suffixChars",
  "humanReplay.multiline",
];

// The guide-driven settings the replay cannot run without: where the guide is,
// where the sandbox bytes come from, where Start Replay browses for sandboxes.
const KEPT_CONFIG = [
  "humanReplay.guidePath",
  "humanReplay.sandboxParent",
  "humanReplay.sandboxRoot",
];

// Pattern sweep, so a renamed leftover ("humanReplay.autocompleteToggle",
// "humanReplay.notes.add") is caught even though it is on no deny-list. Applied
// to contributed ids only, never to descriptions. "complete"/"completion" is
// deliberately absent: the inline completion provider is the surface the replay
// ghost text renders through, so a command naming it would be a false alarm.
const MODEL_SHAPED_ID = /ollama|autocomplete|\bfim\b|model|prompt|comment|note|temperature|debounce|template|multiline|maxTokens|apiBase/i;

// Modules that exist only to serve the removed layers. src/completionProvider.ts
// and src/config.ts are deliberately NOT listed: an inline completion provider
// must still be registered for the ghost text, and a config reader may still be
// wanted for the guide settings, so either filename could legitimately survive
// with its model parts stripped. A false alarm is worse than a miss here.
const REMOVED_MODULES = [
  "src/ollama.ts",
  "src/templates.ts",
  "src/postprocess.ts",
  "src/modelPull.ts",
  "src/noteWeave.ts",
  "src/disclosure/comments.ts",
  "src/disclosure/commentAnchor.ts",
  "src/disclosure/promptgen.ts",
  "src/disclosure/actionability.ts",
];

// Oracles whose whole subject is a removed module.
const REMOVED_ORACLES = [
  "test/note-weave.test.cjs",
  "test/actionability.test.cjs",
  "test/comment-anchor.test.cjs",
  "test/pull-progress.test.cjs", // model-pull progress aggregator
];

const REMOVED_MODULE_NAMES = REMOVED_MODULES.map((p) =>
  path.basename(p, ".ts"),
);

// ---------------------------------------------------------------------------
// 1. No contributed command or setting belongs to a removed layer.
// ---------------------------------------------------------------------------

test("removed commands are gone from contributes.commands", () => {
  for (const id of REMOVED_COMMANDS) {
    assert.ok(
      !commandIds.includes(id),
      `contributed command still present: ${id}`,
    );
  }
});

test("removed command ids appear nowhere in the manifest", () => {
  // Catches leftovers in menus, keybindings and view titles, not just commands.
  for (const id of REMOVED_COMMANDS) {
    assert.ok(
      !MANIFEST_TEXT.includes(id),
      `manifest still references removed command: ${id}`,
    );
  }
  // The comment controller id itself, referenced by the comment-thread menu.
  assert.ok(
    !MANIFEST_TEXT.includes("commentController"),
    "manifest still contributes a comment-thread menu",
  );
});

test("no contributed id is model- or notes-shaped (pattern sweep)", () => {
  const ids = [
    ...commandIds,
    ...configKeys,
    ...keybindings.map((k) => k.command),
    ...Object.values(contributes.menus || {})
      .flat()
      .map((m) => m.command),
    ...Object.values(contributes.views || {})
      .flat()
      .map((v) => v.id),
  ].filter(Boolean);
  for (const id of ids) {
    assert.ok(
      !MODEL_SHAPED_ID.test(id),
      `contributed id looks like the removed layer: ${id}`,
    );
  }
});

test("marketing metadata no longer advertises a model layer", () => {
  const shaped = /ollama|\bfim\b|autocomplete/i;
  assert.ok(
    !shaped.test(pkg.description),
    `description still sells the model layer: ${pkg.description}`,
  );
  for (const kw of pkg.keywords || []) {
    assert.ok(!shaped.test(kw), `keyword still model-shaped: ${kw}`);
  }
  assert.ok(
    !(pkg.categories || []).includes("Machine Learning"),
    "extension still categorised Machine Learning with no model in it",
  );
});

// ---------------------------------------------------------------------------
// 2. The configuration is exactly the guide-driven settings.
// ---------------------------------------------------------------------------

test("configuration keeps exactly the guide-driven settings", () => {
  for (const key of REMOVED_CONFIG) {
    assert.ok(!configKeys.includes(key), `setting still present: ${key}`);
  }
  // Exact set: the replay needs these three and the goal wants nothing else.
  // Adding a guide-driven setting is a deliberate act; update this list with it.
  assert.deepStrictEqual([...configKeys].sort(), [...KEPT_CONFIG].sort());
});

// ---------------------------------------------------------------------------
// 3. The removed modules are off disk and unreferenced.
// ---------------------------------------------------------------------------

test("removed source modules no longer exist", () => {
  for (const rel of REMOVED_MODULES) {
    assert.ok(
      !fs.existsSync(path.join(ROOT, rel)),
      `module still on disk: ${rel}`,
    );
  }
});

test("oracles for removed modules no longer exist", () => {
  for (const rel of REMOVED_ORACLES) {
    assert.ok(
      !fs.existsSync(path.join(ROOT, rel)),
      `oracle for a removed module still on disk: ${rel}`,
    );
  }
});

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

const SRC_FILES = walkFiles(path.join(ROOT, "src"));

test("no file under src/ imports a removed module", () => {
  const specifier = new RegExp(
    `["'](?:\\.{1,2}/)+(?:[\\w.-]+/)*(${REMOVED_MODULE_NAMES.join("|")})(?:\\.js)?["']`,
  );
  for (const file of SRC_FILES) {
    const text = fs.readFileSync(file, "utf8");
    const hit = text.match(specifier);
    assert.ok(
      !hit,
      `${path.relative(ROOT, file)} still imports a removed module: ${hit && hit[0]}`,
    );
  }
});

test("no file under src/ mentions Ollama or FIM by name", () => {
  // Covers the .index.md context docs too: a doc describing a deleted layer is
  // a leftover like any other.
  const named = /ollama|\bfim\b/i;
  for (const file of SRC_FILES) {
    const text = fs.readFileSync(file, "utf8");
    const line = text.split("\n").findIndex((l) => named.test(l));
    assert.strictEqual(
      line,
      -1,
      `${path.relative(ROOT, file)}:${line + 1} still names the model layer`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. The replay surface is still contributed.
// ---------------------------------------------------------------------------

test("every replay command is still contributed", () => {
  for (const id of KEPT_COMMANDS) {
    assert.ok(commandIds.includes(id), `replay command missing: ${id}`);
  }
});

test("the Replay Guide view is still contributed", () => {
  const views = Object.values(contributes.views || {}).flat();
  const guide = views.find((v) => v.id === "humanReplay.guideSteps");
  assert.ok(guide, "humanReplay.guideSteps view missing");
  assert.strictEqual(guide.name, "Replay Guide");
});

test("the Tab keybindings that arm the replay surfaces are intact", () => {
  // command -> key. Each is a surface the human drives from the keyboard: the
  // diff decoration accept, the rewrite strike accept, recovery after an edit,
  // the insert-walk nudge, the diff-replay nudge, the patch pause, plus the
  // escapes that cancel a step or skip a hunk.
  const expected = [
    ["humanReplay.diffReplayAcceptDecoration", "tab"],
    ["humanReplay.acceptRewriteClear", "tab"],
    ["humanReplay.continueDisclosure", "tab"],
    ["humanReplay.nudgeGhost", "tab"],
    ["humanReplay.diffReplayNudge", "tab"],
    ["humanReplay.runNextStep", "tab"],
    ["humanReplay.cancelDisclosure", "escape"],
    ["humanReplay.skipHunk", "shift+escape"],
  ];
  for (const [command, key] of expected) {
    const binding = keybindings.find((b) => b.command === command);
    assert.ok(binding, `keybinding missing for ${command}`);
    assert.strictEqual(binding.key, key, `${command} bound to the wrong key`);
    assert.ok(
      typeof binding.when === "string" && binding.when.includes("editorTextFocus"),
      `${command} keybinding lost its editor guard`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. The shipped bundle carries no model client.
// ---------------------------------------------------------------------------

test("dist/extension.js carries no Ollama or FIM markers", (t) => {
  const bundle = path.join(ROOT, "dist", "extension.js");
  if (!fs.existsSync(bundle)) {
    // Clean checkout, nothing built yet. Nothing to prove.
    t.skip("dist/extension.js absent (run npm run build)");
    return;
  }
  const text = fs.readFileSync(bundle, "utf8");
  const markers = [
    /ollama/i,
    /api\/generate/,
    /localhost:11434/,
    /fim_prefix/,
    /fim_suffix/,
    /fim_middle/,
  ];
  for (const marker of markers) {
    assert.ok(
      !marker.test(text),
      `built bundle still contains ${marker} (stale build? re-run npm run build)`,
    );
  }
});
