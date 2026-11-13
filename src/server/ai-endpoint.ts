/**
 * The one OpenAI-compatible endpoint the Assistant and Reviews talk to (ADR 0010). Plain `fetch`, no provider library.
 * It checks the connection, lists the models, tests a model for tool calling, and makes the one chat call both
 * features use. Reasons for a failure are written here from the status and the shape of the answer, never from the
 * endpoint's own text, so they cannot carry the key back.
 */

export const DEFAULT_AI_BASE_URL = "https://openrouter.ai/api/v1";

const TEST_TIMEOUT_MS = 10_000;
const TOOL_TEST_TIMEOUT_MS = 60_000;

export interface AiEndpoint {
  baseUrl: string;
  /** Local servers may need none. */
  apiKey: string | null;
}

export type ConnectionResult = { ok: true; models?: number } | { ok: false; reason: "unreachable" | "key_refused" | "not_compatible"; error: string };

/** The address as it is kept: http(s) only, no login in it, no trailing slash. Null when it is not usable. */
export function normalizeBaseUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, "");
}

/** Builds a request to the endpoint. Redirects are not followed, so the key never goes to another address. */
export function endpointRequest(endpoint: AiEndpoint, path: string, init: RequestInit = {}): [string, RequestInit] {
  const headers: Record<string, string> = { Accept: "application/json", ...(init.headers as Record<string, string> | undefined) };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  return [`${endpoint.baseUrl}${path}`, { ...init, headers, redirect: "manual" }];
}

/**
 * Asks the endpoint for its model list, a cheap authenticated call every OpenAI-compatible server answers. The
 * reason for a failure is written here from the status and the shape of the answer, never from the endpoint's own text,
 * so it cannot carry the key back.
 */
export async function testConnection(endpoint: AiEndpoint, fetchImpl: typeof fetch = fetch): Promise<ConnectionResult> {
  const listed = await listModels(endpoint, fetchImpl);
  return listed.ok ? { ok: true, models: listed.models.length } : listed;
}

export type ModelsResult = { ok: true; models: string[] } | { ok: false; reason: "unreachable" | "key_refused" | "not_compatible"; error: string };

/** The ids in the endpoint's model list, sorted. Not every endpoint has a list; then the Owner types the name. */
export async function listModels(endpoint: AiEndpoint, fetchImpl: typeof fetch = fetch): Promise<ModelsResult> {
  const failure = await connectionFailure(endpoint, fetchImpl);
  if (failure.response === null) return failure.result;
  const body: unknown = await failure.response.json().catch(() => null);
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return notCompatible;
  const ids = data.map((m) => (typeof m === "object" && m !== null ? (m as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === "string" && id !== "");
  return { ok: true, models: [...new Set(ids)].sort((a, b) => a.localeCompare(b)) };
}

// ---- chat ----

export interface ChatToolCall {
  id: string;
  name: string;
  /** The arguments as the model wrote them: JSON text, not yet checked. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ChatToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ChatTool {
  name: string;
  description: string;
  /** A JSON Schema object for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  /** A hard cap on the tokens of the answer. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export type ChatFailureReason = "unreachable" | "key_refused" | "model_unavailable" | "refused" | "rate_limited" | "not_compatible" | "interrupted" | "aborted";

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ChatToolCall }
  | { type: "usage"; usage: ChatUsage }
  /** Only sent when the token cap cut the answer off (`finish_reason: "length"`); a normal stop sends nothing. */
  | { type: "truncated" }
  | { type: "error"; reason: ChatFailureReason; error: string };

const notCompatible = { ok: false, reason: "not_compatible", error: "The endpoint answered, but not like an OpenAI-compatible server. Check the address." } as const;

async function connectionFailure(endpoint: AiEndpoint, fetchImpl: typeof fetch): Promise<{ response: Response; result?: undefined } | { response: null; result: { ok: false; reason: "unreachable" | "key_refused" | "not_compatible"; error: string } }> {
  let response: Response;
  try {
    response = await fetchImpl(...endpointRequest(endpoint, "/models", { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) }));
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { response: null, result: { ok: false, reason: "unreachable", error: timedOut ? "The endpoint did not answer in time." : "Cannot reach the endpoint. Check the address." } };
  }
  if (response.status === 401 || response.status === 403) {
    return { response: null, result: { ok: false, reason: "key_refused", error: endpoint.apiKey ? "The endpoint refused the key." : "The endpoint wants a key and none is set." } };
  }
  if (response.status >= 300 && response.status < 400) {
    return { response: null, result: { ok: false, reason: "not_compatible", error: "The address redirects elsewhere. Use the address the endpoint answers on." } };
  }
  if (!response.ok) return { response: null, result: { ok: false, reason: "not_compatible", error: `The endpoint answered ${response.status}, not a model list.` } };
  return { response };
}

function statusFailure(status: number, endpoint: AiEndpoint): ChatEvent & { type: "error" } {
  const error = (reason: ChatFailureReason, text: string): ChatEvent & { type: "error" } => ({ type: "error", reason, error: text });
  if (status === 401 || status === 403) return error("key_refused", endpoint.apiKey ? "The endpoint refused the key." : "The endpoint wants a key and none is set.");
  if (status === 404) return error("model_unavailable", "The endpoint does not know this model, or has no chat service at this address.");
  if (status === 429) return error("rate_limited", "The endpoint is limiting requests or the account is out of credit. Try again later.");
  if (status >= 300 && status < 400) return error("not_compatible", "The address redirects elsewhere. Use the address the endpoint answers on.");
  if (status === 400 || status === 422) return error("refused", "The endpoint refused the request. The model may not exist or may not support tools.");
  return error("refused", `The endpoint answered ${status}.`);
}

/** Pieces of a tool call arrive in fragments keyed by index; the arguments are text that is joined. */
interface Pending {
  id: string;
  name: string;
  arguments: string;
}

/**
 * The one chat call (OpenAI chat completions, streamed, only the part of the format every server shares). It yields
 * text as it arrives, each tool call whole once the stream ends, and the token usage. A failure is one `error` event
 * with a reason Fairway wrote, and it is always the last event; this never throws.
 */
export async function* chat(endpoint: AiEndpoint, request: ChatRequest, fetchImpl: typeof fetch = fetch): AsyncGenerator<ChatEvent> {
  const body = {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
    messages: request.messages.map((m) => {
      if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls?.length && { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }),
        };
      }
      return m;
    }),
    ...(request.tools?.length && { tools: request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }),
  };
  const aborted = (): ChatEvent => ({ type: "error", reason: "aborted", error: "The request was cancelled." });
  let response: Response;
  try {
    response = await fetchImpl(...endpointRequest(endpoint, "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body), signal: request.signal }));
  } catch (error) {
    if (request.signal?.aborted) return yield aborted();
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return yield { type: "error", reason: "unreachable", error: timedOut ? "The endpoint did not answer in time." : "Cannot reach the endpoint. Check the address." };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return yield statusFailure(response.status, endpoint);
  }
  if (!response.body) return yield { type: "error", reason: "not_compatible", error: "The endpoint sent no answer." };

  const pending = new Map<number, Pending>();
  let usage: ChatUsage | null = null;
  let sawData = false;
  let finished = false;
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  const handle = (line: string): ChatEvent[] | "done" | null => {
    if (!line.startsWith("data:")) return [];
    const data = line.slice(5).trim();
    if (data === "[DONE]") return "done";
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return [];
    }
    if (typeof chunk !== "object" || chunk === null) return [];
    sawData = true;
    const c = chunk as { error?: unknown; choices?: unknown; usage?: unknown };
    if (c.error) return null;
    const events: ChatEvent[] = [];
    const choice = Array.isArray(c.choices) ? (c.choices[0] as { delta?: Record<string, unknown>; finish_reason?: unknown } | undefined) : undefined;
    const delta = choice?.delta;
    if (choice?.finish_reason === "length") events.push({ type: "truncated" });
    if (delta) {
      if (typeof delta.content === "string" && delta.content !== "") events.push({ type: "text", delta: delta.content });
      if (Array.isArray(delta.tool_calls)) {
        for (const part of delta.tool_calls as Array<{ index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
          const index = typeof part.index === "number" ? part.index : 0;
          const entry = pending.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof part.id === "string") entry.id = part.id;
          if (typeof part.function?.name === "string") entry.name += part.function.name;
          if (typeof part.function?.arguments === "string") entry.arguments += part.function.arguments;
          pending.set(index, entry);
        }
      }
    }
    if (typeof c.usage === "object" && c.usage !== null) {
      const u = c.usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
      if (typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens };
    }
    return events;
  };

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const result = handle(line);
        if (result === "done") {
          finished = true;
          break outer;
        }
        if (result === null) return yield { type: "error", reason: "interrupted", error: "The model stopped with an error before it finished." };
        yield* result;
      }
    }
    if (!finished && buffer.trim() !== "") {
      const result = handle(buffer.replace(/\r$/, ""));
      if (Array.isArray(result)) yield* result;
      else if (result === "done") finished = true;
    }
  } catch {
    if (request.signal?.aborted) return yield aborted();
    return yield { type: "error", reason: "interrupted", error: "The connection to the endpoint broke before the answer was complete." };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!sawData) return yield { type: "error", reason: "not_compatible", error: "The endpoint answered, but not like an OpenAI-compatible server. Check the address." };
  for (const [, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    if (call.name) yield { type: "tool_call", call: { id: call.id, name: call.name, arguments: call.arguments } };
  }
  if (usage) yield { type: "usage", usage };
}

// ---- the tool-calling test ----

export type ToolTestResult = { ok: true } | { ok: false; reason: ChatFailureReason | "no_tool_call"; error: string };

/**
 * Asks the model to call one trivial tool and reports whether it did. Both features depend on tool calling
 * (ADR 0010), so a model that answers in text instead is reported as not usable.
 */
export async function testToolCalling(endpoint: AiEndpoint, model: string, fetchImpl: typeof fetch = fetch): Promise<ToolTestResult> {
  const signal = AbortSignal.timeout(TOOL_TEST_TIMEOUT_MS);
  const events = chat(
    endpoint,
    {
      model,
      messages: [{ role: "user", content: "This is a test of tool calling. Call the tool report_ready now, with ready set to true. Do not answer in text." }],
      tools: [{ name: "report_ready", description: "Reports that the model can call tools.", parameters: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } }],
      signal,
    },
    fetchImpl,
  );
  let called = false;
  for await (const event of events) {
    if (event.type === "tool_call" && event.call.name === "report_ready") called = true;
    if (event.type === "error") {
      if (event.reason === "aborted") return { ok: false, reason: "unreachable", error: "The model did not answer in time." };
      return { ok: false, reason: event.reason, error: event.error };
    }
  }
  if (called) return { ok: true };
  return { ok: false, reason: "no_tool_call", error: "The model answered but did not call the tool. It does not support tool calling, so the Assistant and Reviews cannot use it." };
}
