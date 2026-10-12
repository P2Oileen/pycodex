export interface ConversationTurn {
  submission_id: string;
  turn_id: string;
  prompt: string;
  response: string;
  thinking: string;
  status: string;
  error: string;
  queue: string;
  sender: string;
  kind: string;
}

export interface InputRequest {
  request_id: string;
  text: string;
}

export interface SessionSnapshot {
  title: string;
  model: string;
  running: boolean;
  status: string;
  accepts_input: boolean;
  turns: ConversationTurn[];
  queued_inputs: { queue: string; prompt: string }[];
  input_request: InputRequest | null;
  context_remaining_percent: number | null;
  usage_tokens: number | null;
  auto_compact_token_limit: number | null;
  max_context_window: number | null;
  recorded_rollout_path: string | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  running: boolean;
  spinner: string;
  turn_count: number;
}

export interface SessionEnvelope {
  session_id: string;
  snapshot: SessionSnapshot;
}

export interface SubmittedInput {
  ok: boolean;
  submission_id?: string;
  snapshot: SessionSnapshot;
}

export class BackendError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** One project endpoint; every session operation requires an explicit id. */
export class BackendClient {
  readonly url: string;

  constructor(url: string, private readonly lifetime?: AbortSignal) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Pycodex backend URL must use http:// or https://.");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Use a workspace URL without credentials, query or fragment.");
    }
    this.url = parsed.href.replace(/\/+$/, "");
  }

  async listSessions(): Promise<SessionSummary[]> {
    const result = await this.request<{ sessions: SessionSummary[] }>("api/sessions");
    return result.sessions;
  }

  createSession(): Promise<SessionEnvelope> {
    return this.request<SessionEnvelope>("api/sessions", {});
  }

  closeSession(sessionId: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      `api/sessions/${encodeURIComponent(sessionId)}`, undefined, undefined, "DELETE",
    );
  }

  snapshot(sessionId: string, signal?: AbortSignal): Promise<SessionEnvelope> {
    return this.request<SessionEnvelope>(
      `api/session?session_id=${encodeURIComponent(sessionId)}`,
      undefined,
      signal,
    );
  }

  submit(
    sessionId: string,
    prompt: string,
  ): Promise<SubmittedInput> {
    return this.request<SubmittedInput>("api/session/message", {
      session_id: sessionId,
      sender: "vscode",
      prompt,
    });
  }

  answer(
    sessionId: string,
    requestId: string,
    answer: unknown,
  ): Promise<SubmittedInput> {
    return this.request<SubmittedInput>("api/session/message", {
      session_id: sessionId,
      request_id: requestId,
      answer,
    });
  }

  private async request<T>(
    path: string,
    body?: object,
    signal?: AbortSignal,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> {
    const response = await this.fetchResponse(`${this.url}/${path}`, body, signal, method);
    return await response.json() as T;
  }

  private async fetchResponse(
    url: string,
    body?: object,
    signal?: AbortSignal,
    method = body === undefined ? "GET" : "POST",
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Session deletion drains accepted work, so it has no fixed request deadline.
    const signals = method === "DELETE" ? [] : [AbortSignal.timeout(15_000)];
    if (signal) signals.push(signal);
    if (this.lifetime) signals.push(this.lifetime);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: signals.length ? AbortSignal.any(signals) : undefined,
      });
    } catch (error) {
      if (this.lifetime?.aborted) {
        throw new Error(
          "This project's Pycodex backend has stopped. Open a new chat to start it again; " +
          "use /resume to restore a saved conversation.",
          { cause: error },
        );
      }
      throw new Error(
        `Cannot reach this project's pycodex-ws at ${this.url}. ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      const result = contentType.includes("application/json")
        ? (await response.json()) as { error?: string; detail?: string }
        : {};
      throw new BackendError(
        response.status,
        `${result.error || result.detail || `HTTP ${response.status}`} (${url})`,
      );
    }
    return response;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redactDiagnostic(line: string): string {
  return line
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[redacted]")
    .replace(/((?:authorization|cookie|password|api[_-]?key|token|secret)\s*["']?\s*[:=]\s*).*/gi, "$1[redacted]")
    .replace(/\b(?:Bearer\s+\S+|sk-[\w-]+)\b/gi, "[redacted]");
}
