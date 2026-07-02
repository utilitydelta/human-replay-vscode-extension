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
  /** Is this line, sitting directly above an item, attached trivia? */
  isTriviaLine(line: string): boolean;
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
  isTriviaLine: (t) =>
    t.startsWith("//") || t.startsWith("#[") || t.startsWith("#![") || t.startsWith("/*") || t.startsWith("*"),
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
      default:
        return null;
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
  isTriviaLine: (t) => t.startsWith("//") || t.startsWith("[") || t.startsWith("/*") || t.startsWith("*"),
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
  isTriviaLine: (t) => t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("@"),
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
  isTriviaLine: (t) => t.startsWith("#") || t.startsWith("@"),
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
  isTriviaLine: (t) => t.startsWith("/*") || t.startsWith("*"),
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
  isTriviaLine: (t) => t.startsWith("<!--"),
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
 *  (the caller surfaces it; nothing assumes a default for real files). */
export function languageForFile(filePath: string): LanguageSpec | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return undefined;
  return BY_EXTENSION[filePath.slice(dot).toLowerCase()];
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
