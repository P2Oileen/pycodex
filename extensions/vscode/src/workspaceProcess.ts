import { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { BackendClient, BackendError, errorMessage, redactDiagnostic } from "./backend";

export interface WorkspaceLaunch {
  directory: string;
  command: string;
  args: string[];
}

/** The stdin pipe owns the backend lifetime, including abrupt host termination. */
export class WorkspaceProcess {
  readonly ready: Promise<BackendClient>;
  readonly closed: Promise<void>;
  private child?: ChildProcess;
  private readonly lifetime = new AbortController();
  private finishClose!: () => void;
  private failure?: Error;
  private diagnostics = "";
  private configDirectory?: string;

  constructor(options: WorkspaceLaunch | Promise<WorkspaceLaunch>, startupTimeoutMs = 30_000) {
    this.closed = new Promise<void>(resolve => { this.finishClose = resolve; }).then(async () => {
      if (this.configDirectory) await rm(this.configDirectory, { recursive: true, force: true });
    });
    this.ready = this.start(options, startupTimeoutMs);
  }

  get active(): boolean {
    return !this.lifetime.signal.aborted;
  }

  dispose(): void {
    if (!this.active) return;
    this.lifetime.abort();
    // EOF also works on Windows and lets startup reach normal lifespan cleanup.
    this.child?.stdin?.end();
  }

  private async start(prepared: WorkspaceLaunch | Promise<WorkspaceLaunch>, timeout: number): Promise<BackendClient> {
    try {
      const options = await prepared;
      if (!this.active) throw new Error("The VS Code project has closed.");
      const port = await availablePort();
      this.configDirectory = await mkdtemp(join(tmpdir(), "pycodex-vscode-"));
      const configPath = join(this.configDirectory, "workspaces.json");
      await writeFile(configPath, JSON.stringify({
        workspaces: [{ id: "vscode", work_dir: options.directory, board: false }],
      }) + "\n", { encoding: "utf8", mode: 0o600 });
      if (!this.active) throw new Error("The VS Code project has closed.");
      const child = spawn(options.command, [
        ...options.args,
        "--listen", `127.0.0.1:${port}`,
        "--workspace-config", configPath,
      ], { cwd: options.directory, shell: false, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
      this.child = child;
      const errors = createInterface({ input: child.stderr! });
      errors.on("line", line => {
        this.diagnostics = (this.diagnostics + "\n" + redactDiagnostic(line)).slice(-8_000);
      });
      child.once("error", error => {
        this.failure = new Error(
          `Cannot start pycodex-ws on the workspace host: ${errorMessage(error)}. ` +
          "Select a Python environment in Pycodex settings on that host " +
          "(the remote server for Remote SSH/WSL/Containers).",
        );
      });
      child.stdin!.on("error", error => {
        this.failure ||= new Error(`Backend lifetime pipe failed: ${errorMessage(error)}`);
        this.dispose();
      });
      child.once("exit", () => this.lifetime.abort());
      child.once("close", (code, signal) => {
        this.failure ||= new Error(
          `pycodex-ws exited (${signal || `exit ${code}`}).${this.diagnostics}`,
        );
        this.lifetime.abort();
        errors.close();
        this.finishClose();
      });
      const origin = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + timeout;
      while (this.active && Date.now() < deadline) {
        try {
          const response = await fetch(`${origin}/api/workspaces`, {
            redirect: "error",
            signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(1_000)]),
          });
          if (!response.ok) throw new BackendError(response.status, `Workspace startup: HTTP ${response.status}`);
          const result = await response.json() as { workspaces: { id: string; work_dir: string }[] };
          if (!result.workspaces.some(item => item.id === "vscode" && item.work_dir === options.directory)) {
            throw new Error("The backend did not start the requested project workspace.");
          }
          if (!this.active) break;
          return new BackendClient(`${origin}/w/vscode`, this.lifetime.signal);
        } catch (error) {
          const code = (error as { cause?: { code?: string } }).cause?.code;
          if (!this.active) break;
          if (code !== "ECONNREFUSED") throw error;
        }
        await delay(100);
      }
      throw this.failure || new Error(`pycodex-ws did not start.${this.diagnostics}`);
    } catch (error) {
      this.dispose();
      if (!this.child) {
        this.finishClose();
      }
      throw error;
    }
  }
}

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => {
    listener.close(error => error ? reject(error) : resolve());
  });
  return port;
}
