/**
 * Fill-in-the-Middle (FIM) prompt templates.
 *
 * FIM token formats adapted from continuedev/continue (Apache-2.0),
 * core/autocomplete/templating/AutocompleteTemplate.ts. The model sees the
 * code before the cursor (prefix) and after it (suffix) and infills the gap.
 */

export interface FimTemplate {
  /** Build the raw prompt string sent to the model. */
  build(prefix: string, suffix: string): string;
  /** Stop sequences that terminate generation. */
  stop: string[];
}

const qwen: FimTemplate = {
  build: (prefix, suffix) =>
    `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
  stop: [
    "<|fim_prefix|>",
    "<|fim_suffix|>",
    "<|fim_middle|>",
    "<|fim_pad|>",
    "<|repo_name|>",
    "<|file_sep|>",
    "<|endoftext|>",
  ],
};

const codestral: FimTemplate = {
  build: (prefix, suffix) => `[SUFFIX]${suffix}[PREFIX]${prefix}`,
  stop: ["[PREFIX]", "[SUFFIX]"],
};

const deepseek: FimTemplate = {
  build: (prefix, suffix) =>
    `<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`,
  stop: [
    "<｜fim▁begin｜>",
    "<｜fim▁hole｜>",
    "<｜fim▁end｜>",
    "<|eot_id|>",
    "<|end▁of▁sentence|>",
  ],
};

const starcoder: FimTemplate = {
  build: (prefix, suffix) =>
    `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`,
  stop: [
    "<fim_prefix>",
    "<fim_suffix>",
    "<fim_middle>",
    "<|endoftext|>",
    "</fim_middle>",
  ],
};

const TEMPLATES: Record<string, FimTemplate> = {
  qwen,
  codestral,
  deepseek,
  starcoder,
};

export type TemplateName = "auto" | keyof typeof TEMPLATES;

/** Pick a template explicitly, or infer one from the model tag. */
export function resolveTemplate(
  choice: TemplateName,
  model: string,
): FimTemplate {
  if (choice !== "auto") {
    return TEMPLATES[choice];
  }
  const m = model.toLowerCase();
  if (m.includes("codestral") || m.includes("mistral")) {
    return codestral;
  }
  if (m.includes("deepseek")) {
    return deepseek;
  }
  if (m.includes("starcoder") || m.includes("stable-code")) {
    return starcoder;
  }
  // qwen2.5-coder, codeqwen, and most modern FIM models share this format.
  return qwen;
}
