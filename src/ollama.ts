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

/** One line of Ollama's streaming pull response. */
interface PullEvent {
  status?: string;
  error?: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/** Running aggregate over a pull's per-layer progress events — pure, so the
 *  percentage math is testable without a server. Layers arrive interleaved;
 *  overall progress is completed-over-total across every layer seen so far. */
export class PullProgress {
  private layers = new Map<string, { total: number; completed: number }>();
  private high = 0;

  /** Feed one event; returns overall [0..1] or undefined while sizes are unknown.
   *  Clamped monotonic: a new layer appearing mid-pull grows the denominator,
   *  and a progress bar must never run backwards. */
  note(evt: PullEvent): number | undefined {
    if (evt.digest && evt.total) {
      this.layers.set(evt.digest, { total: evt.total, completed: evt.completed ?? 0 });
    }
    let total = 0;
    let completed = 0;
    for (const l of this.layers.values()) {
      total += l.total;
      completed += l.completed;
    }
    if (total === 0) return undefined;
    this.high = Math.max(this.high, completed / total);
    return this.high;
  }
}

/**
 * Pull a model through Ollama's HTTP API — cross-platform, no shell, no CLI
 * knowledge needed. Streams the layer progress into `onProgress` ([0..1] when
 * sizes are known). Rejects on server error or a failed pull. The caller owns
 * consent: this is only ever invoked from an explicit human gesture.
 */
export async function pullModel(
  apiBase: string,
  model: string,
  signal: AbortSignal,
  onProgress: (fraction: number | undefined, status: string) => void,
): Promise<void> {
  const url = new URL("api/pull", withTrailingSlash(apiBase));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Ollama ${res.status} ${res.statusText}: ${await safeText(res)}`);
  }

  const progress = new PullProgress();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line) as PullEvent;
      if (evt.error) throw new Error(evt.error);
      onProgress(progress.note(evt), evt.status ?? "");
    }
  }
}

/** Installed model names (with tags), or undefined when the server is
 *  unreachable — the readiness check's two questions in one call. */
export async function listModels(apiBase: string, signal?: AbortSignal): Promise<string[] | undefined> {
  try {
    const res = await fetch(new URL("api/tags", withTrailingSlash(apiBase)), { signal });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { models?: { name?: string }[] };
    return (json.models ?? []).map((m) => m.name ?? "").filter((n) => n !== "");
  } catch {
    return undefined;
  }
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
