/**
 * Minimal Ollama client. Talks directly to the local Ollama HTTP server from
 * the extension host — no sidecar process, no cloud. The full FIM prompt is
 * built by us and sent with raw=true so we control the template, independent
 * of the model's own Ollama template.
 */

export interface GenerateParams {
  apiBase: string;
  model: string;
  prompt: string;
  stop: string[];
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
}

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
}

/** Single non-streaming completion. Returns the infilled text. */
export async function generateFim(params: GenerateParams): Promise<string> {
  const url = new URL("api/generate", withTrailingSlash(params.apiBase));

  const body = {
    model: params.model,
    prompt: params.prompt,
    raw: true,
    stream: false,
    keep_alive: 30 * 60,
    options: {
      num_predict: params.maxTokens,
      temperature: params.temperature,
      stop: params.stop,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!res.ok) {
    throw new Error(
      `Ollama ${res.status} ${res.statusText}: ${await safeText(res)}`,
    );
  }

  const json = (await res.json()) as OllamaGenerateResponse;
  if (json.error) {
    throw new Error(`Ollama error: ${json.error}`);
  }
  return json.response ?? "";
}

function withTrailingSlash(base: string): string {
  return base.endsWith("/") ? base : base + "/";
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}
