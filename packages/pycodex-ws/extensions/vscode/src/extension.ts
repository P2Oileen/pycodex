import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BackendClient, errorMessage } from "./backend";
import { BackendSetup, projectPythons } from "./backendSetup";
import { Chat, ChatView } from "./chatView";
import { CapturedContext, editorContext } from "./editorContext";
import { SessionConnection } from "./session";
import { WorkspaceProcess } from "./workspaceProcess";

type ContextResource = vscode.Uri | vscode.SourceControlResourceState;

// VS Code's deactivate entry point receives no context.
let activeFrontend: ChatFrontend | undefined;

export function activate(context: vscode.ExtensionContext): void {
  if (vscode.env.remoteName && context.extension.extensionKind !== vscode.ExtensionKind.Workspace) {
    void vscode.window.showErrorMessage(
      "Pycodex must run in the remote workspace extension host. Install it in the " +
      "SSH/WSL/container workspace and remove any remote.extensionKind override that forces it to run locally.",
    );
    return;
  }
  const frontend = new ChatFrontend(context.extensionUri, context.globalStorageUri);
  activeFrontend = frontend;
  context.subscriptions.push(frontend);
}

export async function deactivate(): Promise<void> {
  const frontend = activeFrontend;
  activeFrontend = undefined;
  await frontend?.close();
}

/** Owns project processes and the chats displayed in the sidebar. */
export class ChatFrontend implements vscode.Disposable {
  private readonly backendSetup = new BackendSetup();
  private readonly workspaces = new Map<string, WorkspaceProcess>();
  private readonly chats = new Map<string, Chat>();
  private readonly processes = new Set<WorkspaceProcess>();
  private readonly restorations = new Map<string, Promise<void>>();
  private readonly view: ChatView;
  private readonly disposables: vscode.Disposable[] = [];
  private lastEditor?: vscode.TextEditor;
  private disposed = false;

  constructor(extensionUri: vscode.Uri, private readonly storageUri: vscode.Uri) {
    this.view = new ChatView(extensionUri, this.chats, {
      open: folder => this.open(folder),
      restore: () => this.restore(),
      settings: folder => this.settings(folder),
      captureContext: () => this.captureContext(),
      closed: chat => { this.chats.delete(chat.key); },
    });
    this.rememberEditor(vscode.window.activeTextEditor);
    this.disposables.push(
      vscode.window.registerWebviewViewProvider("pycodex.chat", this.view),
      vscode.window.onDidChangeActiveTextEditor(editor => this.rememberEditor(editor)),
      vscode.workspace.onDidChangeWorkspaceFolders(event => {
        for (const folder of event.removed) {
          const key = folder.uri.toString();
          this.workspaces.get(key)?.dispose();
          this.workspaces.delete(key);
          this.restorations.delete(key);
        }
      }),
      vscode.commands.registerCommand("pycodex.insertContext", (...resources: (ContextResource | ContextResource[])[]) =>
        this.run(() => this.view.insertContext(() => this.captureContext(resources)))),
      vscode.commands.registerCommand("pycodex.newSession", () =>
        this.run(() => this.open())),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables) disposable.dispose();
    this.view.dispose();
    for (const chat of this.chats.values()) chat.connection.dispose();
    this.chats.clear();
    for (const workspace of this.processes) workspace.dispose();
    this.workspaces.clear();
  }

  async close(): Promise<void> {
    this.dispose();
    await Promise.all([...this.processes].map(workspace => workspace.closed));
  }

  private rememberEditor(editor?: vscode.TextEditor): void {
    if (editor && this.contextFolder(editor.document.uri)) {
      this.lastEditor = editor;
    }
  }

  private contextFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    const direct = vscode.workspace.getWorkspaceFolder(uri);
    if (direct || uri.scheme !== "git") return direct;
    // Git revisions use virtual URIs; their paths still belong to the workspace host.
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const match = vscode.workspace.getWorkspaceFolder(folder.uri.with({ path: uri.path }));
      if (match) return match;
    }
    return undefined;
  }

  private contextSource(): { uri: vscode.Uri; editor?: vscode.TextEditor } {
    const active = vscode.window.activeTextEditor;
    if (active && !active.document.isClosed) return { uri: active.document.uri, editor: active };
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const uris = input instanceof vscode.TabInputTextDiff ? [input.modified, input.original] :
      input instanceof vscode.TabInputText ? [input.uri] : [];
    const previous = this.lastEditor;
    if (previous && !previous.document.isClosed && (!uris.length ||
        uris.some(uri => uri.toString() === previous.document.uri.toString()))) {
      return { uri: previous.document.uri, editor: previous };
    }
    if (uris.length) {
      return {
        uri: uris[0],
        editor: vscode.window.visibleTextEditors.find(editor =>
          editor.document.uri.toString() === uris[0].toString()),
      };
    }
    throw new Error("Open a source file or select files in the workspace to insert code context.");
  }

  private async currentFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const editor = vscode.window.activeTextEditor || this.lastEditor;
    const folder = editor && this.contextFolder(editor.document.uri);
    if (folder) return folder;
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw new Error("Open a workspace folder before starting a chat.");
    if (folders.length === 1) return folders[0];
    return vscode.window.showWorkspaceFolderPick({ placeHolder: "Select a project for Pycodex" });
  }

  private async backend(folder: vscode.WorkspaceFolder): Promise<BackendClient> {
    const directory = await realpath(folder.uri.fsPath);
    if (this.disposed || !vscode.workspace.workspaceFolders?.some(
      item => item.uri.toString() === folder.uri.toString(),
    )) {
      throw new Error("The VS Code project has closed.");
    }
    const key = folder.uri.toString();
    const existing = this.workspaces.get(key);
    if (existing?.active) return existing.ready;
    const configuration = vscode.workspace.getConfiguration("pycodex", folder.uri);
    const launch = {
      directory,
      pythonPath: configuration.get<string>("pythonPath")!,
      profile: configuration.get<string>("profile")!,
    };
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Starting Pycodex for ${folder.name}…`,
      },
      progress => {
        const workspace = new WorkspaceProcess(
          this.backendSetup.prepare(launch, message => progress.report({ message })),
          this.workspaceConfig(directory),
        );
        this.workspaces.set(key, workspace);
        this.processes.add(workspace);
        void workspace.closed.then(
          () => this.processes.delete(workspace),
          error => {
            if (!this.disposed) void vscode.window.showErrorMessage(`Pycodex: ${errorMessage(error)}`);
          },
        );
        return workspace.ready;
      },
    );
  }

  private workspaceConfig(directory: string): string {
    const key = createHash("sha256").update(directory).digest("hex");
    return join(this.storageUri.fsPath, "workspaces", key, "workspaces.json");
  }

  private async restore(folders = vscode.workspace.workspaceFolders || []): Promise<void> {
    const outcomes = await Promise.allSettled(folders.map(folder => {
      const key = folder.uri.toString();
      let restoration = this.restorations.get(key);
      if (!restoration) {
        restoration = this.restoreFolder(folder).catch(error => {
          this.restorations.delete(key);
          throw error;
        });
        this.restorations.set(key, restoration);
      }
      return restoration;
    }));
    const failures = outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, failures.map(errorMessage).join("\n"));
  }

  private async restoreFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const directory = await realpath(folder.uri.fsPath);
    try {
      await access(this.workspaceConfig(directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const backend = await this.backend(folder);
    const sessions = await backend.listSessions();
    if (this.disposed || !vscode.workspace.workspaceFolders?.some(
      item => item.uri.toString() === folder.uri.toString(),
    )) return;
    for (const session of sessions) {
      // The server keeps an initial empty session so every displayed chat can close.
      if (session.turn_count === 0) continue;
      const chat = new Chat(new SessionConnection(backend, session.id), folder);
      this.chats.set(chat.key, chat);
    }
  }

  private async settings(folder?: vscode.WorkspaceFolder): Promise<void> {
    const target = folder || await this.currentFolder();
    if (!target) return;
    const configuration = vscode.workspace.getConfiguration("pycodex", target.uri);
    const setting = await vscode.window.showQuickPick([
      {
        label: "Python 环境", key: "pythonPath",
        description: configuration.get<string>("pythonPath") || "自动检测",
      },
      {
        label: "Profile", key: "profile",
        description: configuration.get<string>("profile") || "默认配置",
      },
    ], { title: `Pycodex 设置 · ${target.name}`, placeHolder: "选择要修改的设置" });
    if (!setting) return;
    const current = configuration.get<string>(setting.key)!;
    const value = setting.key === "pythonPath" ? await this.selectPython(target, current) :
      (await vscode.window.showInputBox({
        title: "Pycodex Profile", value: current,
        prompt: "填写工作区主机 Codex 配置中的 Profile 名称；留空使用默认配置。",
        placeHolder: "例如 step",
      }))?.trim();
    if (value === undefined || value === current || this.disposed) return;
    await configuration.update(
      setting.key, value,
      vscode.workspace.workspaceFile ? vscode.ConfigurationTarget.WorkspaceFolder :
        vscode.ConfigurationTarget.Workspace,
    );
    if (this.workspaces.get(target.uri.toString())?.active) {
      const action = await vscode.window.showInformationMessage(
        `${setting.label}已保存。当前项目仍使用原设置，重新加载窗口后生效；正在执行的任务会先完成。`,
        "重新加载窗口",
      );
      if (action) await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } else {
      void vscode.window.showInformationMessage(`${setting.label}已保存，下次新建对话时生效。`);
    }
  }

  private async selectPython(folder: vscode.WorkspaceFolder, current: string): Promise<string | undefined> {
    const project = await projectPythons(folder.uri.fsPath);
    const choices: (vscode.QuickPickItem & { pythonPath?: string })[] = [
      {
        label: "自动检测", pythonPath: "",
        description: "复用已安装的 Pycodex 或 PATH 中的 Python",
        detail: current ? undefined : "当前选择",
      },
      ...project.map(python => ({
        label: basename(dirname(dirname(python))), pythonPath: python,
        description: python, detail: python === current ? "当前选择" : undefined,
      })),
    ];
    if (current && !project.includes(current)) {
      choices.push({ label: current, pythonPath: current, description: "当前选择" });
    }
    choices.push({ label: "浏览 Python 解释器…", description: "选择其他 venv 或 Python 安装" });
    const choice = await vscode.window.showQuickPick(choices, {
      title: `Python 环境 · ${folder.name}`,
      placeHolder: "选择运行 Pycodex 的 Python；远程窗口使用远端环境",
      matchOnDescription: true,
    });
    if (!choice) return;
    let python = choice.pythonPath;
    if (python === undefined) {
      const files = await vscode.window.showOpenDialog({
        title: "选择 Python 解释器（venv 的 bin/python 或 Scripts/python.exe）",
        openLabel: "选择 Python", defaultUri: folder.uri,
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      });
      if (!files?.length) return;
      python = files[0].fsPath;
    }
    return python ? (await this.backendSetup.inspect(folder.uri.fsPath, python)).python : "";
  }

  private async open(folder?: vscode.WorkspaceFolder): Promise<Chat | undefined> {
    const target = folder || await this.currentFolder();
    if (!target) return;
    await this.restore([target]);
    const backend = await this.backend(target);
    const sessionId = (await backend.createSession()).session_id;
    if (this.disposed) return;
    const chat = new Chat(new SessionConnection(backend, sessionId), target);
    this.chats.set(chat.key, chat);
    await this.view.select(chat);
    return chat;
  }

  private async captureContext(resources: (ContextResource | ContextResource[])[] = []): Promise<CapturedContext> {
    const selected = resources.flat().map(resource => "resourceUri" in resource ? resource.resourceUri : resource);
    const uris = [...new Map(selected.map(uri => [uri.toString(), uri])).values()];
    const active = vscode.window.activeTextEditor;
    const sources = uris.length ? uris.map(uri => ({
      uri,
      // Editor context menus supply one URI; file-tree menus supply selected resources.
      editor: resources.length === 1 && resources[0] === uri
        ? [active, ...vscode.window.visibleTextEditors].find(editor =>
          editor && !editor.document.isClosed && editor.document.uri.toString() === uri.toString())
        : undefined,
    })) : [this.contextSource()];
    const folder = this.contextFolder(sources[0].uri);
    if (!folder || sources.some(source => !this.contextFolder(source.uri))) {
      throw new Error("Open a source file in a workspace to insert code context.");
    }
    const blocks = await Promise.all(sources.map(async source => {
      const document = source.editor?.document || await vscode.workspace.openTextDocument(source.uri);
      return editorContext(document, source.editor?.selection);
    }));
    return { folder, blocks };
  }

  private async run(action: () => unknown | Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!this.disposed) void vscode.window.showErrorMessage(`Pycodex: ${errorMessage(error)}`);
    }
  }
}
