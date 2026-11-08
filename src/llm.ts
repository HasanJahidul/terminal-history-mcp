// Minimal client for an OpenAI-compatible HTTP API: POST {baseUrl}/embeddings and
// POST {baseUrl}/chat/completions. Works with Ollama's /v1 endpoint (the default),
// LM Studio, llama.cpp server, vLLM, or OpenAI itself. Native fetch, no SDK.

export const ENV = {
  baseUrl: "TERMINAL_HISTORY_LLM_BASE_URL",
  embedModel: "TERMINAL_HISTORY_EMBED_MODEL",
  chatModel: "TERMINAL_HISTORY_CHAT_MODEL",
  apiKey: "TERMINAL_HISTORY_LLM_API_KEY",
  allowRemote: "TERMINAL_HISTORY_ALLOW_REMOTE_LLM",
} as const;

export const DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

// Generous because a local server loads the model on the first call: qwen2.5:7b took over
// 120s on its first load right after `ollama pull` (Apple M4); warm, a whole smoke run with
// two chat calls finished in under 9s.
const EMBED_TIMEOUT_MS = 30_000;
const CHAT_TIMEOUT_MS = 300_000;

export type LlmConfig = {
  baseUrl: string;
  embedModel: string;
  chatModel: string | null;
  apiKey: string | null;
};

export type EmbedPurpose = "query" | "document";
export type EmbedFn = (texts: string[], purpose: EmbedPurpose) => Promise<number[][]>;
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatFn = (messages: ChatMessage[]) => Promise<string>;

// "unreachable" = no HTTP response at all (refused, DNS, timeout). Callers use it to stop
// retrying and to fall back to keyword search; "http"/"bad_response" mean the server answered.
export type LlmErrorKind = "unreachable" | "http" | "bad_response";

export class LlmError extends Error {
  constructor(readonly kind: LlmErrorKind, message: string) {
    super(message);
    this.name = "LlmError";
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// Shell history is sensitive even after redaction (hostnames, paths, project names), so the
// default is loopback-only. Any other host needs an explicit opt-in of exactly "1".
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const raw = (env[ENV.baseUrl] ?? "").trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${ENV.baseUrl} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${ENV.baseUrl} must be http(s), got ${url.protocol}`);
  }
  if (!isLoopbackHost(url.hostname) && env[ENV.allowRemote] !== "1") {
    throw new Error(
      `Refusing to send shell history to non-localhost endpoint "${url.host}". ` +
      `Set ${ENV.allowRemote}=1 to opt in.`,
    );
  }
  return {
    baseUrl: raw.replace(/\/+$/, ""),
    embedModel: (env[ENV.embedModel] ?? "").trim() || DEFAULT_EMBED_MODEL,
    chatModel: (env[ENV.chatModel] ?? "").trim() || null,
    apiKey: (env[ENV.apiKey] ?? "").trim() || null,
  };
}

function describeFetchError(e: unknown, timeoutMs: number): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `timed out after ${timeoutMs}ms`;
  return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
}

async function postJson(cfg: LlmConfig, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const url = cfg.baseUrl + path;
  let res: Response;
  let text: string;
  try {
    // The timeout signal also covers reading the body.
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    throw new LlmError("unreachable", `cannot reach ${url} (${describeFetchError(e, timeoutMs)})`);
  }
  if (!res.ok) {
    throw new LlmError("http", `${url} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError("bad_response", `${url} returned a non-JSON body`);
  }
}

// nomic-embed-text was trained with task prefixes and its model card says they are required;
// without them queries and documents land in the wrong regions of the space.
function withTaskPrefix(model: string, text: string, purpose: EmbedPurpose): string {
  if (!model.includes("nomic-embed-text")) return text;
  return (purpose === "query" ? "search_query: " : "search_document: ") + text;
}

export async function embedTexts(cfg: LlmConfig, texts: string[], purpose: EmbedPurpose): Promise<number[][]> {
  if (texts.length === 0) return [];
  const json = await postJson(
    cfg,
    "/embeddings",
    { model: cfg.embedModel, input: texts.map((t) => withTaskPrefix(cfg.embedModel, t, purpose)) },
    EMBED_TIMEOUT_MS,
  );
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new LlmError(
      "bad_response",
      `embeddings: expected ${texts.length} vectors, got ${Array.isArray(data) ? data.length : "none"}`,
    );
  }
  const out: number[][] = new Array(texts.length);
  data.forEach((item: { index?: unknown; embedding?: unknown }, pos: number) => {
    const idx = typeof item?.index === "number" ? item.index : pos;
    const emb = item?.embedding;
    if (!Array.isArray(emb) || emb.length === 0 || !emb.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new LlmError("bad_response", `embeddings: item ${pos} is not a numeric vector`);
    }
    if (idx < 0 || idx >= texts.length) throw new LlmError("bad_response", `embeddings: index ${idx} out of range`);
    out[idx] = emb as number[];
  });
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) throw new LlmError("bad_response", `embeddings: missing vector for input ${i}`);
  }
  return out;
}

export async function chatComplete(cfg: LlmConfig, messages: ChatMessage[]): Promise<string> {
  if (!cfg.chatModel) throw new Error(`no chat model configured (set ${ENV.chatModel})`);
  const json = await postJson(
    cfg,
    "/chat/completions",
    { model: cfg.chatModel, messages, temperature: 0, stream: false },
    CHAT_TIMEOUT_MS,
  );
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new LlmError("bad_response", "chat completion has no message content");
  return content;
}
