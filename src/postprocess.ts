/**
 * Clean up raw model output before it is shown as a ghost-text suggestion.
 */

/** Truncate at the first occurrence of any stop sequence the model leaked. */
export function trimAtStopTokens(text: string, stop: string[]): string {
  let cut = text.length;
  for (const token of stop) {
    const idx = text.indexOf(token);
    if (idx !== -1 && idx < cut) {
      cut = idx;
    }
  }
  return text.slice(0, cut);
}

/** Keep only the first line (plus its newline trimmed) when multiline is off. */
export function toSingleLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.slice(0, idx);
}

/**
 * Avoid suggesting text that just repeats what already follows the cursor.
 * If the completion ends by reproducing the start of the suffix, trim it.
 */
export function dropSuffixOverlap(completion: string, suffix: string): string {
  const trimmedSuffix = suffix.trimStart();
  if (!trimmedSuffix) {
    return completion;
  }
  // Find the largest overlap where the tail of `completion` equals the head
  // of `suffix`.
  const max = Math.min(completion.length, trimmedSuffix.length);
  for (let len = max; len > 0; len--) {
    if (completion.endsWith(trimmedSuffix.slice(0, len))) {
      return completion.slice(0, completion.length - len);
    }
  }
  return completion;
}

export interface PostprocessOptions {
  stop: string[];
  multiline: boolean;
  suffix: string;
}

export function postprocess(raw: string, opts: PostprocessOptions): string {
  let text = trimAtStopTokens(raw, opts.stop);
  if (!opts.multiline) {
    text = toSingleLine(text);
  }
  text = dropSuffixOverlap(text, opts.suffix);
  // Trim trailing whitespace but preserve meaningful trailing newlines for
  // multi-line completions (a single trailing newline is fine to drop).
  return text.replace(/[ \t]+$/g, "").replace(/\n+$/g, "");
}
