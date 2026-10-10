import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { errorMessage } from "./backend";
import type { CapturedContext, ContextBlock } from "./editorContext";
import { SessionConnection } from "./session";

export interface ChatActions {
  open(folder?: vscode.WorkspaceFolder): Promise<Chat | undefined>;
  settings(folder?: vscode.WorkspaceFolder): Promise<void>;
  captureContext(): Promise<CapturedContext>;
  closed(chat: Chat): void;
}

/** One backend session in a project workspace. */
export class Chat {
  readonly key: string;

  constructor(
    readonly connection: SessionConnection,
    readonly folder: vscode.WorkspaceFolder,
  ) {
    this.key = JSON.stringify([connection.backend.url, connection.sessionId]);
  }

  get summary() {
    const state = this.connection.state;
    const snapshot = state.snapshot;
    return {
      sessionKey: this.key,
      sessionId: this.connection.sessionId,
      title: snapshot?.title || "新对话",
      workspace: this.folder.name,
      running: Boolean(snapshot?.running),
      submitting: state.submitting,
      closing: state.closing,
      waitingForInput: Boolean(snapshot?.input_request),
      queued: snapshot?.queued_inputs.length || 0,
      closed: snapshot?.accepts_input === false,
      error: state.error || "",
    };
  }

  async submit(text: string, queue: boolean): Promise<void> {
    if (this.connection.state.submitting) throw new Error("上一条消息仍在发送。");
    await this.connection.submit(queue ? `/queue ${text.trim()}` : text.trim());
  }

  async openLink(href: string): Promise<void> {
    const url = new URL(href, this.folder.uri.toString().replace(/\/+$/, "") + "/");
    if (url.username || url.password) throw new Error("不支持包含凭据的链接。");
    const uri = vscode.Uri.parse(url.href);
    if (uri.scheme === "http" || uri.scheme === "https") {
      await vscode.env.openExternal(uri);
    } else if (uri.scheme === this.folder.uri.scheme && vscode.workspace.getWorkspaceFolder(uri)) {
      await vscode.commands.executeCommand("vscode.open", uri);
    } else {
      throw new Error("只能打开网页或当前工作区中的文件链接。");
    }
  }
}

/** A sidebar with one expanded chat and live summaries of the other chats. */
export class ChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private chat?: Chat;
  private readonly subscriptions = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingContext: { sessionKey: string; blocks: ContextBlock[] }[] = [];
  private ready = false;
  private expandSelected = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly chats: Map<string, Chat>,
    private readonly actions: ChatActions,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.dispose();
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      enableForms: false,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
        vscode.Uri.joinPath(this.extensionUri, "out"),
      ],
    };
    this.disposables.push(
      view.onDidDispose(() => this.dispose()),
      view.onDidChangeVisibility(() => this.observe()),
      view.webview.onDidReceiveMessage(message => this.receive(message)),
    );
    view.webview.html = chatHtml(view.webview, this.extensionUri);
    this.observe();
  }

  async select(chat: Chat): Promise<void> {
    this.chat = chat;
    this.expandSelected = true;
    this.observe();
    this.publish();
    await vscode.commands.executeCommand("pycodex.chat.focus");
  }

  async insertContext(capture = this.actions.captureContext): Promise<void> {
    const selected = this.chat;
    const { folder, blocks } = await capture();
    const chat = selected || await this.actions.open(folder);
    if (!chat) return;
    if (!this.chats.has(chat.key)) throw new Error("Session is closed.");
    if (chat.connection.state.closing) throw new Error("Session is closing.");
    this.pendingContext.push({ sessionKey: chat.key, blocks });
    if (!selected || this.chat === selected) await this.select(chat);
    this.flushContext();
  }

  publish(): void {
    if (!this.view || !this.ready) return;
    const state = this.chat?.connection.state || { submitting: false, closing: false };
    this.view.description = state.snapshot?.title;
    void this.view.webview.postMessage({
      type: "state",
      chats: [...this.chats.values()].map(chat => chat.summary),
      expand: this.expandSelected,
      sessionKey: this.chat?.key || null,
      sessionId: this.chat?.connection.sessionId || "",
      state,
    });
    this.expandSelected = false;
  }

  dispose(): void {
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.view = undefined;
    this.ready = false;
  }

  private observe(): void {
    if (!this.view?.visible) {
      for (const subscription of this.subscriptions.values()) subscription.dispose();
      this.subscriptions.clear();
      this.ready = false;
    } else {
      for (const [key, chat] of this.chats) {
        if (!this.subscriptions.has(key)) {
          this.subscriptions.set(key, chat.connection.subscribe(() => this.publish()));
        }
      }
    }
  }

  private flushContext(): void {
    if (!this.view?.visible || !this.ready) return;
    for (const item of this.pendingContext.splice(0)) {
      if (this.chats.has(item.sessionKey)) {
        void this.view.webview.postMessage({ type: "insert-context", ...item });
      }
    }
  }

  private async receive(value: unknown): Promise<void> {
    const message = value as {
      type?: string; sessionKey?: string | null; text?: string;
      queue?: boolean; requestId?: string; href?: string; targetSessionKey?: string;
    };
    try {
      if (!message || typeof message.type !== "string") throw new Error("Invalid chat message.");
      if (message.type === "ready") {
        this.ready = true;
        this.publish();
        this.flushContext();
        return;
      }
      if (message.type === "activate-session" || message.type === "close-session") {
        const target = typeof message.targetSessionKey === "string"
          ? this.chats.get(message.targetSessionKey) : undefined;
        if (!target) throw new Error("Unknown chat session.");
        if (message.type === "close-session") await this.close(target);
        else await this.select(target);
        return;
      }
      const chat = this.chat;
      if (message.sessionKey !== (chat?.key || null)) {
        throw new Error("对话已切换，请在原对话中重新发送。");
      }
      if (message.type === "new-session") {
        await this.actions.open(chat?.folder);
        return;
      }
      if (message.type === "insert-context") {
        await this.insertContext();
        return;
      }
      if (message.type === "settings") {
        await this.actions.settings(chat?.folder);
        return;
      }
      if (!chat) throw new Error("请先新建对话。");
      switch (message.type) {
        case "submit":
          if (typeof message.text !== "string" || typeof message.queue !== "boolean" ||
              typeof message.requestId !== "string") throw new Error("Invalid chat submission.");
          await chat.submit(message.text, message.queue);
          void this.view?.webview.postMessage({
            type: "sent", sessionKey: chat.key, requestId: message.requestId,
          });
          break;
        case "refresh":
          await chat.connection.refresh();
          break;
        case "cancel-input":
          await chat.connection.cancelInput();
          break;
        case "open-link":
          if (typeof message.href !== "string") throw new Error("Invalid link.");
          await chat.openLink(message.href);
          break;
        default:
          throw new Error("Unknown chat action.");
      }
    } catch (error) {
      void this.view?.webview.postMessage({
        type: "action-error", sessionKey: message?.sessionKey,
        requestId: message?.requestId, error: errorMessage(error),
        retry: message?.type === "new-session" || message?.type === "insert-context" || message?.type === "settings"
          ? message.type : "refresh",
      });
    }
  }

  private async close(chat: Chat): Promise<void> {
    await chat.connection.close();
    this.subscriptions.get(chat.key)?.dispose();
    this.subscriptions.delete(chat.key);
    this.actions.closed(chat);
    if (this.chat === chat) {
      this.chat = [...this.chats.values()].at(-1);
      this.expandSelected = Boolean(this.chat);
    }
    this.publish();
  }
}

function chatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("hex");
  const resource = (path: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, path)).toString();
  const values: Record<string, string> = {
    "__NONCE__": nonce,
    "__CSP_SOURCE__": webview.cspSource,
    "__STYLE_URI__": resource("media/chat.css"),
    "__SCRIPT_URI__": resource("media/chat.js"),
    "__MARKDOWN_URI__": resource("out/markdown-it.min.js"),
  };
  return readFileSync(vscode.Uri.joinPath(extensionUri, "media/chat.html").fsPath, "utf8")
    .replace(/__[A-Z_]+__/g, key => escapeAttribute(values[key]));
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
