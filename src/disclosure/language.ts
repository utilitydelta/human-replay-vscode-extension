// The language registry — the single place per-language tree-sitter knowledge
// lives. Everything else in the engine is language-agnostic: it diffs, anchors,
// and replays whatever parse it is handed. A spec answers the five questions the
// engine asks of a language: how to parse, which nodes are addressable items and
// what their name is, which wrapper nodes an item must be lifted through so
// exports/decorators travel with it, which source lines are attached trivia
// (doc comments, attributes), and which nodes the create walk can descend into.
//
// The create walk is brace-shaped (it opens `{ }` shells and fills them), so
// only brace languages register function types. A language with none routes
// create steps to the whole-symbol surface instead — honest, ground-truth, one
// Tab. Markdown has no functions at all: its items are heading sections, and
// replay runs at line/block grain.

import Parser = require("tree-sitter");
import type { SyntaxNode } from "./walk";

export type LanguageId = "rust" | "csharp" | "typescript" | "tsx" | "python" | "markdown" | "html" | "css";

export interface LanguageSpec {
  id: LanguageId;
  /** Lazily loaded grammar module (native tree-sitter binding). */
  grammar(): unknown;
  /** Node types addressable by name in a guide's **Symbol:** field. */
  namedItemTypes: ReadonlySet<string>;
  /** The item's name, or undefined when the node has none. */
  nameOf(node: SyntaxNode, src: string): string | undefined;
  /** Wrapper node types whose bytes belong to the item (export_statement,
   *  decorated_definition) — extraction lifts through them. */
  liftParents: ReadonlySet<string>;
  /** Is this line, sitting directly above an item, attached trivia? An
   *  attribute followed by code on the same line is not: that line is an item. */
  isTriviaLine(line: string): boolean;
  /** Does this line open an attribute or decorator that closes on a later
   *  line (`#[cfg(any(`)? The trivia walk reads such a block as one line. */
  opensTrivia(line: string): boolean;
  /** Function-shaped node types the create walk can disclose. Empty set =
   *  create steps land whole-symbol instead of walking. */
  functionTypes: ReadonlySet<string>;
  /** The block to open for a container node, or null for leaves. `child` may be
   *  a statement wrapper; implementations unwrap as needed. */
  descendable(child: SyntaxNode): { node: SyntaxNode; block: SyntaxNode } | null;
  /** The body of an item container (impl/class/mod) whose children are named
   *  items, or null when `node` isn't one. Placement knowledge: a create step
   *  whose symbol is nested in one of these in the sandbox must land inside the
   *  matching container in the target, never at end-of-file. */
  containerBody(node: SyntaxNode): SyntaxNode | null;
  /** A container's identity across target and sandbox, for a container with
   *  no name field (a Rust impl). Absent or undefined: a named container is
   *  known by kind and name, any other by its header text. */
  containerIdentity?(node: SyntaxNode, src: string): string | undefined;
  /** Conventional indent the create walk lays blocks out with. The walk assumes
   *  the sandbox follows the language convention; byte-exactness holds when it
   *  does. */
  indentWidth: number;
}

const fieldName = (node: SyntaxNode, src: string): string | undefined => {
  const id = node.childForFieldName("name");
  return id ? src.slice(id.startIndex, id.endIndex) : undefined;
};

// Open a body-like block behind a set of container types. Field names differ per
// grammar; try each until one holds a block-shaped node.
const bodyOf = (node: SyntaxNode, fields: string[], blockTypes: Set<string>): SyntaxNode | null => {
  for (const f of fields) {
    const b = node.childForFieldName(f);
    if (b && blockTypes.has(b.type)) return b;
  }
  return null;
};

// The block of a closure or async block that CLOSES a call's argument list —
// `tasks.push(tokio::spawn(async move { … }))`, `spawn_blocking(move || { … })`.
// Everything after it is `)`s and `;`, so the walk's header/close slicing holds
// and the body's statements disclose one by one instead of arriving as one
// several-hundred-line leaf. Only a trailing one qualifies: a closure with real
// arguments after it would put source bytes between the block and the node's
// end, which the shell has no place for.
const trailingBlockArg = (node: SyntaxNode, depth = 0): SyntaxNode | null => {
  if (depth > 4) return null;
  if (node.type === "async_block") {
    const b = node.namedChild(node.namedChildCount - 1);
    return b && b.type === "block" ? b : null;
  }
  if (node.type === "closure_expression") {
    const b = node.childForFieldName("body");
    return b && b.type === "block" ? b : null;
  }
  if (node.type !== "call_expression" && node.type !== "expression_statement") return null;
  const args = node.type === "call_expression" ? node.childForFieldName("arguments") : node;
  const last = args && args.namedChildCount > 0 ? args.namedChild(args.namedChildCount - 1) : null;
  return last ? trailingBlockArg(last, depth + 1) : null;
};

// Where a string literal starting at `t[i]` ends: the index after its closing
// quote, null when it runs past the end of `t`, undefined when no string starts
// at `i`. Each language has its own literal forms, so each brings its own.
type StringEnd = (t: string, i: number) => number | null | undefined;

const quoted = (t: string, from: number, quote: string, escapes: boolean): number | null => {
  for (let i = from; i < t.length; i++) {
    if (escapes && t[i] === "\\") i++;
    else if (t[i] === quote) return i + 1;
  }
  return null;
};

const charLiteral = (t: string, i: number): number | undefined => {
  const m = /^'(?:\\.[^']*|[^\\'])'/.exec(t.slice(i));
  return m ? i + m[0].length : undefined;
};

// `"..."`, `b"..."`, raw `r#"..."#` (no escapes, ends at the quote and the same
// number of hashes), char literals. A bare `'` is a lifetime, not a quote.
const rustStringEnd: StringEnd = (t, i) => {
  const raw = /^b?r(#*)"/.exec(t.slice(i));
  if (raw && (i === 0 || !/[\w]/.test(t[i - 1]))) {
    const close = t.indexOf(`"${raw[1]}`, i + raw[0].length);
    return close < 0 ? null : close + 1 + raw[1].length;
  }
  if (t[i] === '"') return quoted(t, i + 1, '"', true);
  if (t[i] === "'") return charLiteral(t, i);
  return undefined;
};

// `"..."`, verbatim `@"..."` (no escapes, `""` is a quote), char literals.
const csharpStringEnd: StringEnd = (t, i) => {
  const verbatim = /^(?:\$@|@\$|@)"/.exec(t.slice(i));
  if (verbatim) {
    for (let k = i + verbatim[0].length; k < t.length; k++) {
      if (t[k] !== '"') continue;
      if (t[k + 1] === '"') k++;
      else return k + 1;
    }
    return null;
  }
  if (t[i] === '"') return quoted(t, i + 1, '"', true);
  if (t[i] === "'") return charLiteral(t, i);
  return undefined;
};

// `"..."`, `'...'`, template literals, regex literals. A template with a
// `${` substitution, or an unclosed regex, can nest anything: the scan gives up
// (null), which reads as an attribute still open, the safe answer.
const scriptStringEnd: StringEnd = (t, i) => {
  if (t[i] === '"' || t[i] === "'") return quoted(t, i + 1, t[i], true);
  if (t[i] === "`") {
    const end = quoted(t, i + 1, "`", true);
    return end === null || t.slice(i, end).includes("${") ? null : end;
  }
  if (t[i] === "/" && t[i + 1] !== "/" && t[i + 1] !== "*" && /[(,=:[!&|?{};]$/.test(t.slice(0, i).trimEnd())) {
    let inClass = false;
    for (let k = i + 1; k < t.length; k++) {
      if (t[k] === "\\") k++;
      else if (t[k] === "[") inClass = true;
      else if (t[k] === "]") inClass = false;
      else if (t[k] === "/" && !inClass) return k + 1;
      else if (t[k] === "\n") return null;
    }
    return null;
  }
  return undefined;
};

const OPENERS = "[({";
const CLOSERS = "])}";

// The text after the bracket group that opens at `t[open]`, or null when the
// group does not close in `t` (a multi-line attribute). Brackets inside string
// literals and line comments do not count.
const afterGroup = (t: string, open: number, stringEnd: StringEnd, lineComment = "//"): string | null => {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    if (t.startsWith(lineComment, i)) {
      const eol = t.indexOf("\n", i);
      if (eol < 0) return null;
      i = eol;
      continue;
    }
    const end = stringEnd(t, i);
    if (end === null) return null;
    if (end !== undefined) {
      i = end - 1;
      continue;
    }
    if (OPENERS.includes(t[i])) depth++;
    else if (CLOSERS.includes(t[i]) && --depth === 0) return t.slice(i + 1);
  }
  return null;
};

// `@expr`: a dotted name with any calls, index groups and type arguments
// (`@a.b`, `@Dec<T>()`, `@a()()`, `@(x.y)`). The text after it, null when a
// group runs past the end of `t`.
const afterDecorator = (t: string, stringEnd: StringEnd, lineComment = "//"): string | null => {
  let i = 1;
  while (i < t.length) {
    if (OPENERS.includes(t[i])) {
      const rest = afterGroup(t, i, stringEnd, lineComment);
      if (rest === null) return null;
      i = t.length - rest.length;
    } else if (t[i] === "<") {
      let depth = 0;
      for (; i < t.length; i++) {
        const end = stringEnd(t, i);
        if (end === null) return null;
        if (end !== undefined) i = end - 1;
        else if (t[i] === "<") depth++;
        else if (t[i] === ">" && t[i - 1] !== "=" && --depth === 0) break;
      }
      if (i >= t.length) return null;
      i++;
    } else if (/[\w$.!?]/.test(t[i])) i++;
    else break;
  }
  return t.slice(i);
};

// An attribute or decorator line is trivia only when nothing but more trivia
// follows it on the same line. `#[inline] pub fn get(self) -> u64 { self.0 }`
// is a whole item, and treating it as trivia lets the walk above an item
// swallow every one-liner sibling. A group still open at the end of the line
// is the first line of a multi-line attribute: trivia.
const attributeOnly = (rest: string | null, isTrivia: (t: string) => boolean): boolean =>
  rest === null || rest.trim() === "" || isTrivia(rest.trim());

// `//` and `* ` continuation lines are comments (`*p = 1;` is a statement). `/* .. */` is trivia when it
// runs past the line or only trivia follows it (`/* a */ fn helper() {}` is an
// item).
const commentTrivia = (t: string, isTrivia: (t: string) => boolean): boolean | undefined => {
  if (t.startsWith("//") || /^\*(?!\/)(\s|$)/.test(t)) return true;
  if (!t.startsWith("/*")) return t.startsWith("*/") ? attributeOnly(t.slice(2), isTrivia) : undefined;
  const close = t.indexOf("*/", 2);
  return attributeOnly(close < 0 ? null : t.slice(close + 2), isTrivia);
};

const rustTrivia = (t: string): boolean => {
  const comment = commentTrivia(t, rustTrivia);
  if (comment !== undefined) return comment;
  if (t.startsWith("#[")) return attributeOnly(afterGroup(t, 1, rustStringEnd), rustTrivia);
  if (t.startsWith("#![")) return attributeOnly(afterGroup(t, 2, rustStringEnd), rustTrivia);
  return false;
};

const csharpTrivia = (t: string): boolean => {
  const comment = commentTrivia(t, csharpTrivia);
  if (comment !== undefined) return comment;
  if (t.startsWith("[")) return attributeOnly(afterGroup(t, 0, csharpStringEnd), csharpTrivia);
  return false;
};

const tsTrivia = (t: string): boolean => {
  const comment = commentTrivia(t, tsTrivia);
  if (comment !== undefined) return comment;
  if (t.startsWith("@")) return attributeOnly(afterDecorator(t, scriptStringEnd), tsTrivia);
  return false;
};

const cssTrivia = (t: string): boolean => commentTrivia(t, cssTrivia) === true;

// `<!-- .. -->` is trivia when it runs past the line or only trivia follows it.
const htmlTrivia = (t: string): boolean => {
  if (!t.startsWith("<!--")) return false;
  const close = t.indexOf("-->", 4);
  return attributeOnly(close < 0 ? null : t.slice(close + 3), htmlTrivia);
};

const rustOpens = (t: string): boolean =>
  (t.startsWith("#[") && afterGroup(t, 1, rustStringEnd) === null) ||
  (t.startsWith("#![") && afterGroup(t, 2, rustStringEnd) === null);
const csharpOpens = (t: string): boolean => t.startsWith("[") && afterGroup(t, 0, csharpStringEnd) === null;
const decoratorOpens = (t: string): boolean => t.startsWith("@") && afterDecorator(t, scriptStringEnd) === null;
const pythonOpens = (t: string): boolean => t.startsWith("@") && afterDecorator(t, scriptStringEnd, "#") === null;

const pythonTrivia = (t: string): boolean => {
  if (t.startsWith("#")) return true;
  if (t.startsWith("@")) return attributeOnly(afterDecorator(t, scriptStringEnd, "#"), pythonTrivia);
  return false;
};

const RUST_ITEMS = new Set([
  "function_item",
  "struct_item",
  "enum_item",
  "union_item",
  "const_item",
  "static_item",
  "type_item",
  "trait_item",
  "mod_item",
  "macro_definition",
]);

export const RUST: LanguageSpec = {
  indentWidth: 4,
  id: "rust",
  grammar: () => require("tree-sitter-rust"),
  namedItemTypes: RUST_ITEMS,
  nameOf: fieldName,
  liftParents: new Set(),
  isTriviaLine: rustTrivia,
  opensTrivia: rustOpens,
  functionTypes: new Set(["function_item"]),
  descendable(child) {
    let node = child;
    if (child.type === "expression_statement" && child.namedChildCount === 1) node = child.namedChild(0)!;
    const BLOCK = new Set(["block"]);
    switch (node.type) {
      case "function_item":
      case "for_expression":
      case "while_expression":
      case "loop_expression":
        return withBlock(node, bodyOf(node, ["body"], BLOCK));
      case "if_expression":
        if (node.childForFieldName("alternative")) return null; // if/else reveals whole
        return withBlock(node, bodyOf(node, ["consequence"], BLOCK));
      // Item containers walk too: shape first, members one by one.
      case "impl_item":
      case "trait_item":
      case "mod_item":
        return withBlock(node, bodyOf(node, ["body"], new Set(["declaration_list"])));
      default:
        return withBlock(node, trailingBlockArg(node));
    }
  },
  containerBody(node) {
    const BODIES = new Set(["declaration_list"]);
    switch (node.type) {
      case "impl_item":
      case "trait_item":
      case "mod_item":
        return bodyOf(node, ["body"], BODIES);
      default:
        return null;
    }
  },
  // `impl SlotScan` and `impl<'a> SlotScan<'a>` are one impl: generics are
  // header detail a later step or the human may change. A trait impl keeps
  // its own identity.
  containerIdentity(node, src) {
    if (node.type !== "impl_item") return undefined;
    const base = (field: string): string => {
      let n = node.childForFieldName(field);
      if (n?.type === "generic_type") n = n.childForFieldName("type");
      return n ? src.slice(n.startIndex, n.endIndex) : "";
    };
    return `impl:${base("trait")}:${base("type")}`;
  },
};

const CSHARP_ITEMS = new Set([
  "class_declaration",
  "struct_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "delegate_declaration",
  "method_declaration",
  "constructor_declaration",
  "property_declaration",
  "local_function_statement",
]);

export const CSHARP: LanguageSpec = {
  indentWidth: 4,
  id: "csharp",
  grammar: () => require("tree-sitter-c-sharp"),
  namedItemTypes: CSHARP_ITEMS,
  nameOf: fieldName,
  liftParents: new Set(),
  // `[Fact]`-style attributes sit on their own line above the declaration.
  isTriviaLine: csharpTrivia,
  opensTrivia: csharpOpens,
  functionTypes: new Set(["method_declaration", "constructor_declaration", "local_function_statement"]),
  descendable(child) {
    const BLOCK = new Set(["block"]);
    switch (child.type) {
      case "method_declaration":
      case "constructor_declaration":
      case "local_function_statement":
      case "for_statement":
      case "for_each_statement":
      case "while_statement":
        return withBlock(child, bodyOf(child, ["body"], BLOCK));
      case "if_statement":
        if (child.childForFieldName("alternative")) return null;
        return withBlock(child, bodyOf(child, ["consequence"], BLOCK));
      // Item containers walk too: shape first, members one by one. A record
      // with no body (positional only) has no declaration_list → leaf.
      case "class_declaration":
      case "struct_declaration":
      case "interface_declaration":
      case "record_declaration":
      case "namespace_declaration":
        return withBlock(child, bodyOf(child, ["body"], new Set(["declaration_list"])));
      default:
        return null;
    }
  },
  containerBody(node) {
    const BODIES = new Set(["declaration_list"]);
    switch (node.type) {
      case "class_declaration":
      case "struct_declaration":
      case "interface_declaration":
      case "record_declaration":
      case "namespace_declaration":
        return bodyOf(node, ["body"], BODIES);
      default:
        return null;
    }
  },
};

const TS_ITEMS = new Set([
  "function_declaration",
  "class_declaration",
  "method_definition",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "variable_declarator",
]);

const tsSpec = (id: LanguageId, pick: (m: { typescript: unknown; tsx: unknown }) => unknown): LanguageSpec => ({
  indentWidth: 2,
  id,
  grammar: () => pick(require("tree-sitter-typescript")),
  namedItemTypes: TS_ITEMS,
  nameOf: fieldName,
  // `export function f` / `export const K`: the export keyword belongs to the item.
  liftParents: new Set(["export_statement", "lexical_declaration", "variable_declaration"]),
  isTriviaLine: tsTrivia,
  opensTrivia: decoratorOpens,
  functionTypes: new Set(["function_declaration", "method_definition"]),
  descendable(child) {
    const BLOCK = new Set(["statement_block"]);
    switch (child.type) {
      case "function_declaration":
      case "method_definition":
      case "for_statement":
      case "for_in_statement":
      case "while_statement":
        return withBlock(child, bodyOf(child, ["body"], BLOCK));
      case "if_statement":
        if (child.childForFieldName("alternative")) return null;
        return withBlock(child, bodyOf(child, ["consequence"], BLOCK));
      // Item container: a class walks shape-first, members one by one.
      case "class_declaration":
        return withBlock(child, bodyOf(child, ["body"], new Set(["class_body"])));
      default:
        return null;
    }
  },
  containerBody(node) {
    return node.type === "class_declaration" ? bodyOf(node, ["body"], new Set(["class_body"])) : null;
  },
});

export const TYPESCRIPT = tsSpec("typescript", (m) => m.typescript);
export const TSX = tsSpec("tsx", (m) => m.tsx);

export const PYTHON: LanguageSpec = {
  indentWidth: 4,
  id: "python",
  grammar: () => require("tree-sitter-python"),
  namedItemTypes: new Set(["function_definition", "class_definition"]),
  nameOf: fieldName,
  // Decorators live on a wrapping decorated_definition — they are the item's
  // bytes, exactly like Rust attributes.
  liftParents: new Set(["decorated_definition"]),
  isTriviaLine: pythonTrivia,
  opensTrivia: pythonOpens,
  // Indentation blocks, not braces: the create walk's open-a-shell gesture does
  // not translate. Create steps land whole-symbol.
  functionTypes: new Set(),
  descendable: () => null,
  containerBody(node) {
    return node.type === "class_definition" ? bodyOf(node, ["body"], new Set(["block"])) : null;
  },
};

export const MARKDOWN: LanguageSpec = {
  indentWidth: 4,
  id: "markdown",
  grammar: () => require("@tree-sitter-grammars/tree-sitter-markdown"),
  namedItemTypes: new Set(["section"]),
  // A section's name is its heading text — the stable human-facing anchor.
  nameOf(node, src) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i)!;
      if (c.type === "atx_heading" || c.type === "setext_heading") {
        return src
          .slice(c.startIndex, c.endIndex)
          .replace(/^#+\s*/, "")
          .trim();
      }
    }
    return undefined;
  },
  liftParents: new Set(),
  isTriviaLine: () => false,
  opensTrivia: () => false,
  functionTypes: new Set(),
  descendable: () => null,
  containerBody: () => null,
};

// The css grammar declares no fields; find a child by type instead.
const childOfType = (node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode | null => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (types.has(c.type)) return c;
  }
  return null;
};

const CSS_BLOCKS = new Set(["block", "keyframe_block_list"]);

export const CSS: LanguageSpec = {
  indentWidth: 2,
  id: "css",
  grammar: () => require("tree-sitter-css"),
  namedItemTypes: new Set(["rule_set", "media_statement", "supports_statement", "keyframes_statement"]),
  // A rule's name is its prelude — the selector list or at-rule condition —
  // whitespace-collapsed: the same text a human reads, stable across reflow.
  nameOf(node, src) {
    const block = childOfType(node, CSS_BLOCKS);
    const text = src
      .slice(node.startIndex, block ? block.startIndex : node.endIndex)
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 0 ? text : undefined;
  },
  liftParents: new Set(),
  isTriviaLine: cssTrivia,
  opensTrivia: () => false,
  functionTypes: new Set(),
  descendable: () => null,
  // @media / @supports group whole rules — a rule created inside one in the
  // sandbox must land inside the matching group in the target.
  containerBody(node) {
    if (node.type !== "media_statement" && node.type !== "supports_statement") return null;
    return childOfType(node, new Set(["block"]));
  },
};

// Tags the HTML spec guarantees unique per document — addressable bare. Any
// other element needs an id: matching the first of many `div`s would replace
// the wrong element's bytes, which is a guess, not ground truth.
const HTML_UNIQUE_TAGS = new Set(["html", "head", "body", "title"]);
const HTML_TAGS = new Set(["start_tag", "self_closing_tag"]);

export const HTML: LanguageSpec = {
  indentWidth: 2,
  id: "html",
  grammar: () => require("tree-sitter-html"),
  namedItemTypes: new Set(["element", "script_element", "style_element"]),
  // `tag#id` when the element carries an id; bare tag only when unique by spec.
  nameOf(node, src) {
    const tag = childOfType(node, HTML_TAGS);
    if (!tag) return undefined;
    const name = childOfType(tag, new Set(["tag_name"]));
    if (!name) return undefined;
    const tagText = src.slice(name.startIndex, name.endIndex);
    for (let i = 0; i < tag.namedChildCount; i++) {
      const attr = tag.namedChild(i)!;
      if (attr.type !== "attribute") continue;
      const key = childOfType(attr, new Set(["attribute_name"]));
      if (!key || src.slice(key.startIndex, key.endIndex) !== "id") continue;
      const quoted = childOfType(attr, new Set(["quoted_attribute_value"]));
      const value = quoted ? childOfType(quoted, new Set(["attribute_value"])) : childOfType(attr, new Set(["attribute_value"]));
      if (value) return `${tagText}#${src.slice(value.startIndex, value.endIndex)}`;
    }
    return HTML_UNIQUE_TAGS.has(tagText) ? tagText : undefined;
  },
  liftParents: new Set(),
  isTriviaLine: htmlTrivia,
  opensTrivia: () => false,
  functionTypes: new Set(),
  descendable: () => null,
  containerBody: () => null,
};

function withBlock(node: SyntaxNode, block: SyntaxNode | null): { node: SyntaxNode; block: SyntaxNode } | null {
  return block ? { node, block } : null;
}

const BY_EXTENSION: Record<string, LanguageSpec> = {
  ".rs": RUST,
  ".cs": CSHARP,
  ".ts": TYPESCRIPT,
  ".mts": TYPESCRIPT,
  ".cts": TYPESCRIPT,
  ".js": TYPESCRIPT, // TS grammar parses plain JS
  ".mjs": TYPESCRIPT,
  ".cjs": TYPESCRIPT,
  ".tsx": TSX,
  ".jsx": TSX,
  ".py": PYTHON,
  ".md": MARKDOWN,
  ".markdown": MARKDOWN,
  ".html": HTML,
  ".htm": HTML,
  ".css": CSS,
};

/** The language a file replays as, by extension — undefined when unsupported
 *  (the caller surfaces it; nothing assumes a default for real files). Accepts
 *  the guide's `path:line` form: a step's File field carries an optional line
 *  for the human's ctrl-click, and a raw pass-through turned `.cs:19` into an
 *  unknown extension. */
export function languageForFile(filePath: string): LanguageSpec | undefined {
  const bare = filePath.split(":")[0];
  const dot = bare.lastIndexOf(".");
  if (dot < 0) return undefined;
  return BY_EXTENSION[bare.slice(dot).toLowerCase()];
}

// One parser per language, reused — parser construction is the expensive part.
const parsers = new Map<LanguageId, Parser>();
export function parserFor(spec: LanguageSpec): Parser {
  let p = parsers.get(spec.id);
  if (!p) {
    p = new Parser();
    // Grammar modules ship nominal Language types; cast across.
    p.setLanguage(spec.grammar() as Parser.Language);
    parsers.set(spec.id, p);
  }
  return p;
}
