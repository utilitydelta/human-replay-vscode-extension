// Turn collated inline comments into a prompt for the sandbox agent (S10).
//
// The model writes the prose; it never decides whether to send (invariant 2) and
// never decides whether there *is* an actionable task — S10 proved a 7B fabricates
// on vague / conflicting / absent comments. So the caller pre-gates (no comments →
// no call) and the human always reads the result before it sends. The template
// carries S10's faithfulness rules plus two few-shot demonstrations (conflict →
// surface, vague → ask back), because the 7B copies examples better than it obeys
// rules.

export interface PendingComment {
  line: number; // 1-based, for the human-facing prompt
  text: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const SYSTEM = [
  "You convert a senior engineer's inline code-review comments into ONE precise instruction",
  "for a coding agent working in a sandbox. Rules:",
  "1. Every instruction must trace to a comment. Do NOT invent requirements the comments do not support.",
  "2. Preserve the engineer's intent and any named invariants verbatim. Keep a question a question.",
  "3. Be specific: name the symbol and the lines, say what to change and why.",
  "4. If the comments conflict, surface the conflict and ask the engineer to resolve it — do not pick one silently.",
  "5. If a comment is too vague to act on, or there are no comments, say so — do NOT fabricate a task.",
  "6. Output only the prompt for the agent — no preamble, no restating these rules.",
].join("\n");

// Few-shot: teach rules 4 and 5 by demonstration — the cases a 7B fabricates on.
export const SHOTS: ChatMessage[] = [
  {
    role: "user",
    content:
      "Symbol — flush (writer):\n```rust\nfn flush(&mut self) { for b in self.pending.drain(..) { self.sink.write_all(&b); } }\n```\nComments:\n- line 1: \"make this async and parallelize the writes\"\n- line 1: \"no — the sink needs ordered writes, keep it sequential\"\n\nWrite the prompt.",
  },
  {
    role: "assistant",
    content:
      "These two comments on `flush` conflict and I can't satisfy both: one asks to parallelize the writes for speed, the other says the sink requires ordered writes so they must stay sequential. Please resolve which constraint wins before I change anything.",
  },
  {
    role: "user",
    content:
      "Symbol — handle (dispatcher):\n```rust\nfn handle(&self, m: Msg) -> Reply { /* ... */ }\n```\nComments:\n- line 1: \"idk, this feels off, clean it up?\"\n\nWrite the prompt.",
  },
  {
    role: "assistant",
    content:
      "The only comment on `handle` — \"this feels off, clean it up\" — is too vague to act on safely. What specifically feels off: the control flow, the naming, the error handling, something else? I won't refactor blind.",
  },
];

function numbered(code: string): string {
  return code.split("\n").map((l, i) => `${String(i + 1).padStart(2)} | ${l}`).join("\n");
}

export function buildMessages(
  symbol: string,
  code: string,
  comments: PendingComment[],
  fewShot = true,
): ChatMessage[] {
  const annotated = comments
    .map((c) => `- line ${c.line} (\`${(code.split("\n")[c.line - 1] || "").trim()}\`): "${c.text}"`)
    .join("\n");
  const user = [
    `Symbol under review — ${symbol}:`,
    "```rust",
    numbered(code),
    "```",
    "",
    "The engineer left these inline comments while reading it:",
    annotated,
    "",
    "Write the prompt instructing the sandbox agent what to change.",
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    ...(fewShot ? SHOTS : []),
    { role: "user", content: user },
  ];
}

/** Call the local instruct model's chat endpoint. Returns the generated prompt. */
export async function generatePrompt(
  apiBase: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const base = apiBase.endsWith("/") ? apiBase : apiBase + "/";
  const res = await fetch(new URL("api/chat", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0.2 } }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Ollama ${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as { message?: { content?: string }; error?: string };
  if (json.error) throw new Error(`Ollama error: ${json.error}`);
  return json.message?.content ?? "";
}
