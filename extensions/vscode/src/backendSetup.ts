import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { errorMessage, redactDiagnostic } from "./backend";
import type { WorkspaceLaunch } from "./workspaceProcess";

interface PythonEnvironment {
  python: string;
  sitePackages: string;
  version: string | null;
  workspaceAlias: boolean;
}

export interface BackendOptions {
  directory: string;
  pythonPath: string;
  profile: string;
}

/** Reuses the workspace host's installation, including its original interpreter. */
export class BackendSetup {
  private readonly installations = new Map<string, Promise<PythonEnvironment>>();

  constructor(private readonly minimumVersion = "0.3.1") {}

  async prepare(options: BackendOptions, report: (message: string) => void): Promise<WorkspaceLaunch> {
    report("Checking the installed Python backend…");
    let environment = await this.inspect(options.directory, options.pythonPath);
    const key = environment.sitePackages;
    let installation = this.installations.get(key);
    if (!installation && !meetsMinimumVersion(environment.version, this.minimumVersion)) {
      report(`${environment.version ? "Upgrading" : "Installing"} python-codex >= ${this.minimumVersion}…`);
      installation = this.install(environment);
      this.installations.set(key, installation);
    } else if (installation) {
      report("Waiting for the Python backend installation…");
    }
    if (installation) {
      try {
        environment = await installation;
      } finally {
        if (this.installations.get(key) === installation) this.installations.delete(key);
      }
    }
    report("Starting the Python backend…");
    return {
      directory: options.directory,
      command: environment.python,
      args: ["-m", "workspace_server", ...(options.profile ? ["--profile", options.profile] : [])],
    };
  }

  /** Resolves and validates a selection without installing anything. */
  async inspect(directory: string, pythonPath: string): Promise<PythonEnvironment> {
    if (pythonPath) {
      const command = await findExecutable(pythonPath, directory);
      if (!command) {
        throw new Error(
          "找不到所选的 Python，请在设置中重新选择 Python 环境。\n" +
          `Python: ${pythonPath}\n远程工作区需要选择远端的 Python。`,
        );
      }
      return inspectPython(command, []);
    }
    const installed = await findExecutable("pycodex-ws", directory) ||
      await findExecutable("pycodex", directory);
    if (installed) {
      if ((await stat(installed)).size > 1_048_576) {
        throw new Error("Cannot read the Pycodex launcher. Select a Python environment in settings.");
      }
      const python = pythonFromLauncher(await readFile(installed));
      const command = await findExecutable(python, directory);
      if (!command) throw new Error("The existing Pycodex installation's Python interpreter is missing.");
      return inspectPython(command, []);
    }
    const interpreter = await findPython(directory);
    return inspectPython(interpreter.command, interpreter.args);
  }

  private async install(environment: PythonEnvironment): Promise<PythonEnvironment> {
    const requirements = [`python-codex>=${this.minimumVersion}`];
    // The optional alias pins the core to an exact version and must advance with it.
    if (environment.workspaceAlias) requirements.push(`pycodex-ws>=${this.minimumVersion}`);
    try {
      await runPython(environment.python, [
        "-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "--no-input", ...requirements,
      ]);
    } catch (error) {
      throw new Error(
        "Pycodex 安装失败。请重试或打开设置。\n" +
        `Python: ${environment.python}\n${errorMessage(error)}`,
      );
    }
    const updated = await inspectPython(environment.python, []);
    if (!meetsMinimumVersion(updated.version, this.minimumVersion)) {
      throw new Error(
        `pip finished, but this Python still reports python-codex ${updated.version || "not installed"}; ` +
        `version ${this.minimumVersion} or newer is required.`,
      );
    }
    return updated;
  }
}

/** Only inspect the project's conventional environment locations. */
export async function projectPythons(directory: string): Promise<string[]> {
  const executable = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  const candidates = await Promise.all([".venv", "venv"].map(name =>
    findExecutable(join(directory, name, ...executable), directory)));
  return candidates.filter((candidate): candidate is string => candidate !== undefined);
}

async function findExecutable(command: string, directory: string): Promise<string | undefined> {
  const explicit = isAbsolute(command) || /[/\\]/.test(command);
  const directories = explicit ? [""] : (process.env.PATH || process.env.Path || "").split(delimiter);
  const extensions = process.platform === "win32" && !/\.[^/\\]+$/.test(command)
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const entry of directories) {
    for (const extension of extensions) {
      const candidate = resolve(directory, entry, command + extension);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
  }
  return undefined;
}

async function findPython(directory: string): Promise<{ command: string; args: string[] }> {
  const candidates = process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
  for (const name of candidates) {
    const command = await findExecutable(name, directory);
    if (command) return { command, args: name === "py" ? ["-3"] : [] };
  }
  throw new Error(
    "Python was not found on the workspace host. Install Python there and reload VS Code, " +
    "or select a Python environment in Pycodex settings. " +
    "Remote SSH/WSL/Containers require Python on the remote server.",
  );
}

/** Standard pip/uv POSIX scripts and pip's Windows distlib executable launchers. */
export function pythonFromLauncher(contents: Buffer): string {
  let header = contents;
  if (contents.subarray(0, 2).toString() === "MZ") {
    const zip = contents.indexOf(Buffer.from("PK\x03\x04"));
    const shebang = zip < 0 ? -1 : contents.lastIndexOf(Buffer.from("#!"), zip);
    header = shebang < 0 ? Buffer.alloc(0) : contents.subarray(shebang, zip);
  }
  const text = header.toString("utf8");
  let python = /^#!([^\r\n]+)\r?\n/.exec(text)?.[1].trim();
  if (python === "/bin/sh") {
    python = /^#!\/bin\/sh\r?\n'''exec' (.+) "\$0" "\$@"\r?\n/.exec(text)?.[1];
  }
  if (python?.startsWith("/usr/bin/env ")) python = python.slice("/usr/bin/env ".length);
  if (python?.startsWith('"') && python.endsWith('"')) python = python.slice(1, -1);
  const name = python?.split(/[/\\]/).at(-1);
  if (!python || !name || !/^(?:pythonw?[\d.]*|pypy[\d.]*)(?:\.exe)?$/i.test(name)) {
    throw new Error(
      "Cannot identify the Python interpreter in this launcher. " +
      "Select a Python environment in Pycodex settings.",
    );
  }
  return python;
}

/** Compare normalized Python release versions, including prereleases and local builds. */
export function meetsMinimumVersion(version: string | null, minimum: string): boolean {
  if (version === null) return false;
  const match = /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:(a|b|rc)\d+)?(?:\.post(\d+))?(?:\.dev(\d+))?(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/i.exec(version);
  if (!match) throw new Error(`Invalid python-codex package version: ${redactDiagnostic(version)}`);
  if (Number(match[1] || 0) > 0) return true;
  const release = match[2].split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(release.length, required.length); index++) {
    const difference = (release[index] || 0) - (required[index] || 0);
    if (difference) return difference > 0;
  }
  return !match[3] && (match[4] !== undefined || match[5] === undefined);
}

async function inspectPython(command: string, args: string[]): Promise<PythonEnvironment> {
  // Metadata inspection must also work before the package (or its backport) is installed.
  const code = `
import sys
if sys.version_info < (3, 6, 2):
    raise RuntimeError("Pycodex requires Python 3.6.2 or newer")
import importlib.util
import json
import sysconfig
if sys.version_info >= (3, 8):
    from importlib import metadata
elif importlib.util.find_spec("importlib_metadata") is not None:
    import importlib_metadata as metadata
elif importlib.util.find_spec("pycodex") is None:
    metadata = None
else:
    raise RuntimeError("This Pycodex installation is missing its importlib_metadata dependency")
def version(name):
    if metadata is None:
        return None
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None
print(json.dumps({
    "python": sys.executable,
    "sitePackages": sysconfig.get_path("purelib"),
    "version": version("python-codex"),
    "workspaceAlias": version("pycodex-ws") is not None,
}))
`;
  const output = await runPython(command, [...args, "-c", code], true);
  let environment: PythonEnvironment;
  try {
    environment = JSON.parse(output) as PythonEnvironment;
  } catch (error) {
    throw new Error(`Python returned invalid backend installation metadata. ${redactDiagnostic(errorMessage(error))}`);
  }
  if (!environment || typeof environment.python !== "string" || !isAbsolute(environment.python) ||
      typeof environment.sitePackages !== "string" || !isAbsolute(environment.sitePackages) ||
      (environment.version !== null && typeof environment.version !== "string") ||
      typeof environment.workspaceAlias !== "boolean") {
    throw new Error("Python returned invalid backend installation metadata.");
  }
  return environment;
}

async function runPython(command: string, args: string[], inspect = false): Promise<string> {
  return new Promise((accept, reject) => {
    // Keep probe/pip imports out of the project's source directory. HOME is preserved.
    const child = spawn(command, args, {
      cwd: join(__dirname, ".."), shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], timeout: inspect ? 15_000 : undefined,
    });
    let output = "";
    let diagnostics = "";
    const streams = [child.stdout, child.stderr].map(stream => {
      const lines = createInterface({ input: stream });
      lines.on("line", line => {
        if (inspect && stream === child.stdout) output = (output + line + "\n").slice(-65_536);
        diagnostics = (diagnostics + "\n" + redactDiagnostic(line)).slice(-8_000);
      });
      return lines;
    });
    child.once("error", error => reject(new Error(redactDiagnostic(errorMessage(error)))));
    child.once("close", (code, signal) => {
      for (const stream of streams) stream.close();
      if (code === 0) accept(output);
      else reject(new Error(`Python ${inspect ? "version check" : "pip"} failed (${signal || code}).${diagnostics}`));
    });
  });
}
