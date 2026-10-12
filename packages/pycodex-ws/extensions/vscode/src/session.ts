import { BackendClient, errorMessage, SessionSnapshot } from "./backend";

export interface SessionState {
  snapshot?: SessionSnapshot;
  error?: string;
  submitting: boolean;
  closing: boolean;
}

/**
 * A subscription to one backend session, independent of any VS Code view.
 * Disposing a connection only stops observation; it never closes the runtime.
 */
export class SessionConnection {
  private snapshot?: SessionSnapshot;
  private error?: string;
  private pendingSubmissions = 0;
  private readonly listeners = new Set<(state: SessionState) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private revision = 0;
  private disposed = false;
  private closing = false;

  constructor(
    readonly backend: BackendClient,
    readonly sessionId: string,
  ) {}

  get state(): SessionState {
    return {
      snapshot: this.snapshot,
      error: this.error,
      submitting: this.pendingSubmissions > 0,
      closing: this.closing,
    };
  }

  subscribe(listener: (state: SessionState) => void): { dispose(): void } {
    if (this.disposed) throw new Error("Session connection is disposed.");
    this.listeners.add(listener);
    listener(this.state);
    if (this.listeners.size === 1) void this.refresh();
    return {
      dispose: () => {
        this.listeners.delete(listener);
        if (!this.listeners.size) this.stopPolling();
      },
    };
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.closing) return;
    this.stopPolling();
    const revision = this.revision;
    const request = new AbortController();
    this.request = request;
    let succeeded = false;
    try {
      const result = await this.backend.snapshot(this.sessionId, request.signal);
      if (this.disposed || this.revision !== revision) return;
      if (result.session_id !== this.sessionId) {
        throw new Error("Workspace server returned a different session.");
      }
      this.snapshot = result.snapshot;
      this.error = undefined;
      succeeded = true;
      this.publish();
    } catch (error) {
      if (this.disposed || this.revision !== revision) return;
      this.error = errorMessage(error);
      this.publish();
    } finally {
      if (!this.disposed && this.revision === revision) {
        this.request = undefined;
        if (succeeded) this.schedule();
      }
    }
  }

  async submit(prompt: string): Promise<void> {
    await this.send(() => this.backend.submit(this.sessionId, prompt));
  }

  async cancelInput(): Promise<void> {
    const request = this.snapshot?.input_request;
    if (!request) throw new Error("There is no pending question in this session.");
    await this.send(() => this.backend.answer(this.sessionId, request.request_id, null));
  }

  async close(): Promise<void> {
    if (this.disposed) throw new Error("Session connection is disposed.");
    if (this.closing) throw new Error("Session is already closing.");
    this.closing = true;
    this.stopPolling();
    this.publish();
    try {
      await this.backend.closeSession(this.sessionId);
      this.dispose();
    } catch (error) {
      this.closing = false;
      this.error = errorMessage(error);
      if (!this.disposed) this.publish();
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this.listeners.clear();
  }

  private async send(operation: () => Promise<unknown>): Promise<void> {
    if (this.disposed) throw new Error("Session connection is disposed.");
    if (this.closing) throw new Error("Session is closing.");
    this.stopPolling();
    this.pendingSubmissions += 1;
    this.error = undefined;
    this.publish();
    try {
      // A POST is never retried: the backend may already have accepted it.
      await operation();
      await this.refresh();
    } catch (error) {
      if (!this.disposed) {
        this.error = errorMessage(error);
        this.publish();
      }
      throw error;
    } finally {
      this.pendingSubmissions -= 1;
      if (!this.disposed) this.publish();
    }
  }

  private schedule(): void {
    if (this.disposed || this.closing || !this.listeners.size) return;
    const active = this.snapshot?.running || this.snapshot?.queued_inputs.length;
    this.timer = setTimeout(() => void this.refresh(), active ? 500 : 2_000);
  }

  private stopPolling(): void {
    this.revision += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.request = undefined;
  }

  private publish(): void {
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }
}
