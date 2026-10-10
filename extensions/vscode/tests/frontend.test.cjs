const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { BackendClient } = require("../out/backend");
const { projectPythons } = require("../out/backendSetup");

function vscodeFixture(directory) {
  const commands = new Map();
  const views = [];
  const providers = new Map();
  const errors = [];
  const editorChanges = new Set();
  const folderChanges = new Set();
  const executed = [];
  const external = [];
  const documents = new Map();
  const openedDocuments = [];
  const configurations = new Map();
  const parseUri = value => {
    const url = new URL(value);
    return {
      fsPath: decodeURIComponent(url.pathname), path: decodeURIComponent(url.pathname),
      scheme: url.protocol.slice(0, -1), authority: url.host,
      toString: () => url.href,
      with(changes) {
        const next = new URL(url.href);
        if (changes.scheme !== undefined) next.protocol = changes.scheme + ":";
        if (changes.authority !== undefined) next.host = changes.authority;
        if (changes.path !== undefined) next.pathname = changes.path;
        if (changes.query !== undefined) next.search = changes.query;
        return parseUri(next.href);
      },
    };
  };
  const uri = file => parseUri(`vscode-remote://ssh-remote+fixture${file}`);
  const event = listeners => handler => {
    listeners.add(handler);
    return { dispose: () => listeners.delete(handler) };
  };
  class Position {
    constructor(line, character) { this.line = line; this.character = character; }
  }
  class Range {
    constructor(start, end) { this.start = start; this.end = end; }
  }
  class Selection extends Range {
    constructor(anchor, active) {
      super(anchor, active);
      this.anchor = anchor;
      this.active = active;
      this.isEmpty = anchor.line === active.line && anchor.character === active.character;
    }
  }
  class TabInputText {
    constructor(uri) { this.uri = uri; }
  }
  class TabInputTextDiff {
    constructor(original, modified) { this.original = original; this.modified = modified; }
  }
  const api = {
    views, providers, errors, editorChanges, folderChanges, executed, external, documents, openedDocuments,
    configurations, configurationUpdates: [],
    quickPicks: [], pickResults: [], inputBoxes: [], inputResults: [],
    openDialogs: [], openResults: [], informations: [], infoResults: [],
    nextFolder: undefined, folderInputs: [],
    env: { remoteName: "ssh-remote", openExternal: async value => { external.push(value); return true; } },
    ExtensionKind: { UI: 1, Workspace: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { One: 1, Two: 2, Nine: 9, Beside: -2 },
    Position, Range, Selection, TabInputText, TabInputTextDiff,
    Uri: {
      parse: parseUri,
      joinPath: (base, ...parts) => {
        const value = new URL(base.toString());
        value.pathname = path.posix.join(value.pathname, ...parts);
        return parseUri(value.href);
      },
    },
    TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      tabGroups: { activeTabGroup: { activeTab: undefined } },
      onDidChangeActiveTextEditor: event(editorChanges),
      withProgress: (_options, action) => action({ report() {} }),
      async showErrorMessage(message) { errors.push(message); },
      async showQuickPick(items, options) {
        api.quickPicks.push({ items, options });
        const selected = api.pickResults.shift();
        return items.find(item => item.label === selected);
      },
      async showInputBox(options) {
        api.inputBoxes.push(options);
        return api.inputResults.shift();
      },
      async showOpenDialog(options) {
        api.openDialogs.push(options);
        return api.openResults.shift();
      },
      async showInformationMessage(message, ...actions) {
        api.informations.push({ message, actions });
        return api.infoResults.shift();
      },
      async showWorkspaceFolderPick(options) {
        api.folderInputs.push(options);
        return api.nextFolder;
      },
      registerWebviewViewProvider(id, provider) {
        providers.set(id, provider);
        return { dispose: () => providers.delete(id) };
      },
    },
    showSidebar() {
      const existing = views.find(view => !view.disposed);
      if (existing) {
        existing.show();
        return existing;
      }
      const contribution = require("../package.json").contributes;
      const container = contribution.viewsContainers.activitybar[0];
      const viewType = contribution.views[container.id][0].id;
      assert.equal(contribution.views[container.id][0].type, "webview");
      assert.ok(providers.has(viewType), "the activity-bar view has a registered provider");
      const received = new Set();
      const disposed = new Set();
      const visibility = new Set();
      const view = {
        viewType, visible: true, disposed: false, messages: [],
        onDidDispose: event(disposed),
        onDidChangeVisibility: event(visibility),
        webview: {
          html: "", options: {}, cspSource: "https://fixture.vscode-resource.test",
          asWebviewUri: value => parseUri("https://fixture.vscode-resource.test" + new URL(value.toString()).pathname),
          onDidReceiveMessage: event(received),
          async postMessage(message) { view.messages.push(structuredClone(message)); return !view.disposed; },
        },
        setVisible(value) {
          view.visible = value;
          for (const handler of visibility) handler();
        },
        show() { view.setVisible(true); },
        async receive(message) {
          for (const handler of received) await handler({
            sessionKey: state(view)?.sessionKey || null, ...message,
          });
        },
        dispose() {
          if (view.disposed) return;
          view.disposed = true;
          for (const handler of [...disposed]) handler();
        },
      };
      views.push(view);
      providers.get(viewType).resolveWebviewView(view);
      return view;
    },
    workspace: {
      workspaceFolders: [{ name: "fixture", uri: uri(directory) }],
      getWorkspaceFolder: documentUri => api.workspace.workspaceFolders.find(
        folder => documentUri.scheme === folder.uri.scheme && documentUri.authority === folder.uri.authority &&
          documentUri.fsPath.startsWith(folder.uri.fsPath + path.sep),
      ),
      async openTextDocument(documentUri) {
        openedDocuments.push(documentUri);
        const document = documents.get(documentUri.toString());
        if (!document) throw new Error("File not found: " + documentUri.fsPath);
        return document;
      },
      getConfiguration: (section, resource) => {
        assert.equal(section, "pycodex");
        const uri = resource.toString();
        if (!configurations.has(uri)) configurations.set(uri, { pythonPath: "", profile: "" });
        const values = configurations.get(uri);
        return {
          get: key => values[key],
          async update(key, value, target) {
            api.configurationUpdates.push({ uri, key, value, target });
            values[key] = value;
          },
        };
      },
      onDidChangeWorkspaceFolders: event(folderChanges),
    },
    editor(file, line) {
      if (typeof file === "string" && file.startsWith("/workspace/")) file = path.join(directory, file.slice(11));
      const resource = typeof file === "string" ? uri(file) : file;
      const document = {
        uri: resource, fileName: resource.fsPath, languageId: "typescript",
        version: 1, isDirty: false, isClosed: false, lineCount: 40,
        lineAt: () => ({ text: "const a = 1;" }),
      };
      const position = new Position(line, 0);
      const editor = { document, viewColumn: 1, selection: new Selection(position, position), revealRange() {} };
      documents.set(resource.toString(), document);
      return editor;
    },
    commands: {
      registerCommand(name, handler) {
        commands.set(name, handler);
        return { dispose: () => commands.delete(name) };
      },
      async executeCommand(...args) {
        executed.push(args);
        if (args[0] === "pycodex.chat.focus") api.showSidebar();
      },
    },
  };
  return { api, invoke: (name, ...args) => commands.get(name)(...args) };
}

function state(view) { return view.messages.filter(message => message.type === "state").at(-1); }

async function frontend(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pycodex-frontend-")));
  const launches = [];
  const inspections = [];
  const sessions = new Map();
  const requests = [];
  const closedSessions = [];
  let nextSessionId = 0;
  const create = () => {
    const id = String(++nextSessionId);
    sessions.set(id, {
      title: `Session ${id}`, model: "fixture", running: false, status: "",
      accepts_input: true, turns: [], queued_inputs: [], input_request: null,
      context_remaining_percent: 100, recorded_rollout_path: null,
      usage_tokens: null, auto_compact_token_limit: 80000, max_context_window: 100000,
    });
    return id;
  };
  if (options.existingSession) create();
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(request.url, "http://fixture");
    let payload;
    if (request.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      closedSessions.push(id);
      if (options.closeError) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: options.closeError }));
        return;
      }
      if (options.closeGate) await options.closeGate;
      sessions.delete(id);
      payload = { ok: true };
    } else if (url.pathname.endsWith("/api/sessions")) {
      if (request.method === "POST") {
        const id = create();
        payload = { session_id: id, snapshot: sessions.get(id) };
      } else {
        payload = { sessions: [...sessions].map(([id, snapshot]) => ({ id, ...snapshot, turn_count: snapshot.turns.length })) };
      }
    } else if (url.pathname.endsWith("/message")) {
      requests.push(body);
      if (options.messageGate) await options.messageGate;
      const snapshot = sessions.get(body.session_id);
      if (body.request_id) snapshot.input_request = null;
      else if (/^\/model(?:\s|$)/.test(body.prompt)) {
        const model = body.prompt.slice(6).trim();
        const busy = snapshot.running || snapshot.queued_inputs.length;
        if (model && !busy) snapshot.model = model;
        snapshot.turns.push({
          submission_id: `turn-${requests.length}`, turn_id: `turn-${requests.length}`,
          prompt: "", thinking: "", queue: "", sender: body.sender, kind: "control",
          status: model && busy ? "failed" : "completed",
          error: model && busy ? "Cannot change model while work is running or queued." : "",
          response: model && busy ? "" : model ? `Switched model to ${model}.` :
            `Current model: ${snapshot.model}\nAvailable models: fixture, fixture-next`,
        });
      }
      else snapshot.turns.push({
        submission_id: `turn-${requests.length}`, turn_id: `turn-${requests.length}`,
        prompt: body.prompt, response: "answer", thinking: "",
        status: "completed", error: "", queue: "steer", sender: body.sender, kind: "assistant",
      });
      payload = { ok: true, snapshot };
    } else {
      const id = url.searchParams.get("session_id");
      payload = { session_id: id, snapshot: sessions.get(id) };
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fixture = vscodeFixture(directory);
  class WorkspaceProcess {
    constructor(launch) {
      this.lifetime = new AbortController();
      this.closed = new Promise(resolve => { this.finishClose = resolve; });
      this.ready = Promise.resolve(launch).then(async resolved => {
        this.launch = resolved;
        await options.startup;
        return new BackendClient(`${origin}/w/vscode`, this.lifetime.signal);
      }).catch(error => {
        this.dispose();
        throw error;
      });
      launches.push(this);
    }
    get active() { return !this.lifetime.signal.aborted; }
    dispose() {
      this.lifetime.abort();
      void Promise.resolve(options.processCloseGate).then(this.finishClose);
    }
  }
  const originalLoad = Module._load;
  Module._load = function (name, ...args) {
    if (name === "vscode") return fixture.api;
    if (name === "./workspaceProcess") return { WorkspaceProcess };
    if (name === "./backendSetup") return { projectPythons, BackendSetup: class {
      async prepare(launch, report) {
        report("Checking the installed Python backend…");
        await options.prepare?.(launch);
        return launch;
      }
      async inspect(directory, python) {
        inspections.push({ directory, python });
        return options.inspect ? options.inspect(directory, python) : { python };
      }
    } };
    return originalLoad.call(this, name, ...args);
  };
  let Frontend;
  let activate;
  let deactivate;
  try {
    delete require.cache[require.resolve("../out/extension")];
    delete require.cache[require.resolve("../out/chatView")];
    ({ ChatFrontend: Frontend, activate, deactivate } = require("../out/extension"));
  } finally {
    Module._load = originalLoad;
  }
  const extensionUri = fixture.api.Uri.parse(pathToFileURL(path.join(__dirname, "..")).href);
  const instance = new Frontend(extensionUri);
  t.after(async () => {
    await instance.close();
    await deactivate();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function ready(view) {
    view.show();
    await view.receive({ type: "ready" });
    const deadline = Date.now() + 2_000;
    while (state(view)?.sessionKey && !state(view).state.snapshot && Date.now() < deadline) await delay(5);
    assert.ok(!state(view).sessionKey || state(view).state.snapshot.accepts_input);
    assert.deepEqual(fixture.api.errors, []);
  }
  async function send(view, text, queue = false) {
    await ready(view);
    await view.receive({ type: "submit", text, queue, requestId: "request-" + requests.length });
  }
  async function select(view, id) {
    const chat = state(view).chats.find(chat => chat.sessionId === id);
    await view.receive({ type: "activate-session", targetSessionKey: chat.sessionKey });
    await ready(view);
  }
  return { ...fixture, instance, activate, deactivate, extensionUri, sessions, requests, closedSessions, ready, send, select, launches, inspections, directory };
}

test("frontend close waits for backends already closing after folder removal", async t => {
  let finish;
  const processCloseGate = new Promise(resolve => { finish = resolve; });
  const { api, instance, invoke, launches } = await frontend(t, { processCloseGate });
  try {
    await invoke("pycodex.newSession");
    const folder = api.workspace.workspaceFolders[0];
    for (const change of api.folderChanges) change({ removed: [folder], added: [] });
    assert.equal(launches[0].active, false);
    let closed = false;
    const closing = instance.close().then(() => { closed = true; });
    await delay(10);
    assert.equal(closed, false);
    finish();
    await closing;
    assert.equal(closed, true);
    await instance.close();
  } finally {
    finish();
  }
});

test("VS Code deactivation waits for the owned backend to finish", async t => {
  let finish;
  const processCloseGate = new Promise(resolve => { finish = resolve; });
  const { api, instance, activate, deactivate, extensionUri, invoke, launches } =
    await frontend(t, { processCloseGate });
  instance.dispose();
  const subscriptions = [];
  activate({
    extension: { extensionKind: api.ExtensionKind.Workspace, id: "randomizez.pycodex" },
    extensionUri, subscriptions,
  });
  try {
    await invoke("pycodex.newSession");
    let closed = false;
    const closing = deactivate().then(() => { closed = true; });
    await delay(10);
    assert.equal(launches[0].active, false);
    assert.equal(closed, false);
    finish();
    await closing;
    assert.equal(closed, true);
    await deactivate();
  } finally {
    finish();
    for (const disposable of subscriptions) disposable.dispose();
  }
});

test("new sessions send plain prompts and disposing the sidebar keeps the runtimes", async t => {
  const { api, invoke, requests, sessions, ready, send, select } = await frontend(t);
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 2);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  api.window.activeTextEditor = api.editor("/workspace/second.ts", 8);
  await invoke("pycodex.newSession");
  assert.equal(api.views.length, 1);
  assert.deepEqual(state(view).chats.map(chat => chat.sessionId), ["1", "2"]);
  await select(view, "1");
  await send(view, "explain first");
  await select(view, "2");
  await send(view, "explain second", true);
  assert.equal(requests[0].session_id, "1");
  assert.equal(requests[0].prompt, "explain first");
  assert.equal(requests[1].session_id, "2");
  assert.equal(requests[1].prompt, "/queue explain second");
  assert.equal("source" in state(view), false);
  assert.equal(state(view).chats[0].workspace, "fixture");
  assert.ok(requests.every(request => !("context_text" in request)));
  view.dispose();
  assert.equal(sessions.get("1").accepts_input, true);
  assert.equal(sessions.size, 2);
  const restored = api.showSidebar();
  await ready(restored);
  assert.equal(state(restored).sessionId, "2");
});

test("the sidebar can create another session in its workspace without an open source file", async t => {
  const { api, invoke, ready, send, requests } = await frontend(t);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  api.window.activeTextEditor = api.editor("/outside/second.ts", 15);
  await view.receive({ type: "new-session" });
  await send(view, "workspace task");
  assert.equal(requests[0].prompt, "workspace task");
  assert.equal(state(view).sessionId, "2");
  assert.equal(api.views.length, 1);
});

test("a multi-root workspace without an editor lets the user choose the new session's project", async t => {
  const { api, invoke, ready, launches } = await frontend(t);
  const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pycodex-other-project-")));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  const folder = { name: "other", uri: api.Uri.parse("vscode-remote://ssh-remote+fixture" + other) };
  api.workspace.workspaceFolders.push(folder);
  await invoke("pycodex.newSession");
  assert.equal(launches.length, 0);
  assert.equal(api.folderInputs.length, 1);
  api.nextFolder = folder;
  await invoke("pycodex.newSession");
  await ready(api.views[0]);
  assert.equal(launches[0].launch.directory, other);
  assert.equal(state(api.views[0]).chats[0].workspace, "other");
});

test("context is captured once and held until the webview is ready, with no automatic send", async t => {
  const { api, invoke, requests, ready, send } = await frontend(t);
  const editor = api.editor("/workspace/first.ts", 2);
  api.window.activeTextEditor = editor;
  await invoke("pycodex.insertContext");
  const panel = api.views[0];
  assert.equal(panel.messages.length, 0);
  assert.equal(requests.length, 0);
  editor.document.isDirty = true;
  editor.document.version = 2;
  editor.document.lineAt = () => ({ text: "changed after inserting" });
  editor.document.isClosed = true;
  await ready(panel);
  const inserted = panel.messages.filter(message => message.type === "insert-context");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].sessionKey, state(panel).sessionKey);
  assert.equal(inserted[0].blocks[0].label, "first.ts:3");
  assert.match(inserted[0].blocks[0].text, /Cursor: line 3,/);
  assert.match(inserted[0].blocks[0].text, /Document version: 1/);
  assert.match(inserted[0].blocks[0].text, /const a = 1;/);
  assert.match(inserted[0].blocks[0].text, /vscode-remote:\/\/ssh-remote/);
  assert.doesNotMatch(inserted[0].blocks[0].text, /changed after inserting/);
  await ready(panel);
  assert.equal(panel.messages.filter(message => message.type === "insert-context").length, 1);
  const edited = "explain\n\n" + inserted[0].blocks[0].text.replaceAll("const a = 1;", "const edited = 2;");
  await send(panel, edited);
  assert.equal(requests[0].prompt, edited);
  await send(panel, "continue");
  assert.equal(requests[1].prompt, "continue");
});

test("inserting context targets the selected session instead of creating or rebinding one", async t => {
  const { api, invoke, ready, select, sessions, requests } = await frontend(t);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  const first = state(view).sessionKey;
  await invoke("pycodex.newSession");
  await ready(view);
  await select(view, "1");
  const editor = api.editor("/workspace/other.ts", 15);
  for (const change of api.editorChanges) change(editor);
  api.window.activeTextEditor = undefined;
  await view.receive({ type: "insert-context" });
  const inserted = view.messages.at(-1);
  assert.equal(inserted.type, "insert-context");
  assert.equal(inserted.sessionKey, first);
  assert.match(inserted.blocks[0].text, /other.ts/);
  assert.match(inserted.blocks[0].text, /Cursor: line 16,/);
  assert.equal(sessions.size, 2);
  assert.equal(requests.length, 0);
});

test("context waiting for a hidden webview keeps its original session after another session opens", async t => {
  const { api, invoke, ready } = await frontend(t);
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 2);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  const first = state(view).sessionKey;
  view.setVisible(false);
  await invoke("pycodex.insertContext");
  await invoke("pycodex.newSession");
  assert.equal(view.messages.some(message => message.type === "insert-context"), false);
  await ready(view);
  assert.equal(state(view).sessionId, "2");
  const inserted = view.messages.filter(message => message.type === "insert-context");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].sessionKey, first);
  await ready(view);
  assert.equal(view.messages.filter(message => message.type === "insert-context").length, 1);
});

test("read-only Git diff context keeps the original revision and resolves the remote project", async t => {
  const { api, invoke, ready, requests, launches, directory } = await frontend(t);
  const working = api.editor("/workspace/changed.ts", 7);
  working.document.lineAt = () => ({ text: "working tree text" });
  const original = api.editor(working.document.uri.with({
    scheme: "git", authority: "", query: JSON.stringify({ path: working.document.fileName, ref: "HEAD" }),
  }), 4);
  original.document.lineAt = () => ({ text: "original revision text" });
  api.window.activeTextEditor = original;
  assert.equal(api.workspace.getWorkspaceFolder(original.document.uri), undefined);
  await invoke("pycodex.insertContext", original.document.uri);
  await ready(api.views[0]);
  const block = api.views[0].messages.find(message => message.type === "insert-context").blocks[0];
  assert.equal(block.label, "changed.ts:5 (Git)");
  assert.match(block.text, /original revision text/);
  assert.match(block.text, /Cursor: line 5,/);
  assert.doesNotMatch(block.text, /working tree text/);
  assert.equal(launches[0].launch.directory, directory);
  assert.equal(requests.length, 0);
  api.window.activeTextEditor = working;
  api.window.visibleTextEditors = [original, working];
  await invoke("pycodex.insertContext", original.document.uri);
  assert.equal(api.views[0].messages.at(-1).blocks[0].label, "changed.ts:5 (Git)");
  const keybinding = require("../package.json").contributes.keybindings[0];
  assert.equal(keybinding.when, "editorTextFocus");
});

test("a diff tab supplies context when the sidebar has focus, without using an unrelated last editor", async t => {
  const { api, invoke, ready } = await frontend(t);
  const unrelated = api.editor("/workspace/unrelated.ts", 1);
  for (const change of api.editorChanges) change(unrelated);
  const modified = api.editor("/workspace/diff.ts", 10);
  const original = api.editor(modified.document.uri.with({ scheme: "git", authority: "" }), 4);
  api.window.tabGroups.activeTabGroup.activeTab = {
    input: new api.TabInputTextDiff(original.document.uri, modified.document.uri),
  };
  api.window.visibleTextEditors = [original, modified];
  await invoke("pycodex.insertContext");
  const view = api.views[0];
  await ready(view);
  const first = view.messages.find(message => message.type === "insert-context").blocks[0];
  assert.equal(first.label, "diff.ts:11");
  assert.doesNotMatch(first.text, /unrelated.ts/);
  for (const change of api.editorChanges) change(original);
  await view.receive({ type: "insert-context" });
  assert.equal(view.messages.at(-1).blocks[0].label, "diff.ts:5 (Git)");
});

test("file-tree selections capture the selected files once without an active editor", async t => {
  const { api, invoke, ready } = await frontend(t);
  const first = api.editor("/workspace/first.ts", 3).document;
  const second = api.editor("/workspace/second.ts", 9).document;
  second.isDirty = true;
  second.lineAt = () => ({ text: "unsaved second file" });
  await invoke("pycodex.insertContext", first.uri, [first.uri, second.uri]);
  const view = api.views[0];
  await ready(view);
  const blocks = view.messages.find(message => message.type === "insert-context").blocks;
  assert.deepEqual(blocks.map(block => block.label), ["first.ts", "second.ts"]);
  assert.match(blocks[0].text, /40: const a = 1;/);
  assert.match(blocks[1].text, /Unsaved changes: true/);
  assert.match(blocks[1].text, /40: unsaved second file/);
  assert.doesNotMatch(blocks[0].text, /Cursor:/);
  assert.equal(api.openedDocuments.length, 2);
  const menus = require("../package.json").contributes.menus;
  for (const menu of ["explorer/context", "scm/resourceState/context"]) {
    assert.equal(menus[menu][0].command, "pycodex.insertContext");
  }
});

test("SCM resources are captured as files and asynchronous reads keep their original chat", async t => {
  const { api, invoke, ready } = await frontend(t);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  const key = state(view).sessionKey;
  const document = api.editor("/workspace/scm.ts", 9).document;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  api.workspace.openTextDocument = async uri => {
    assert.equal(uri.toString(), document.uri.toString());
    started();
    await gate;
    return document;
  };
  const inserting = invoke("pycodex.insertContext", { resourceUri: document.uri });
  await reading;
  await invoke("pycodex.newSession");
  await ready(view);
  release();
  await inserting;
  assert.equal(state(view).sessionId, "2");
  const inserted = view.messages.at(-1);
  assert.equal(inserted.type, "insert-context");
  assert.equal(inserted.sessionKey, key);
  assert.equal(inserted.blocks[0].label, "scm.ts");
});

test("a file read failure stays visible and does not insert another editor's context", async t => {
  const { api, invoke, sessions } = await frontend(t);
  api.window.activeTextEditor = api.editor("/workspace/unrelated.ts", 0);
  const missing = api.editor("/workspace/missing.ts", 0).document.uri;
  api.documents.delete(missing.toString());
  await invoke("pycodex.insertContext", { resourceUri: missing });
  assert.match(api.errors[0], /File not found/);
  assert.equal(sessions.size, 0);
  assert.equal(api.views.length, 0);
});

test("pending-question cancellation stays in its session", async t => {
  const { api, invoke, requests, sessions, ready } = await frontend(t);
  await invoke("pycodex.newSession");
  const panel = api.views[0];
  await ready(panel);
  sessions.get("1").input_request = { request_id: "question-1", text: "Allow?" };
  await panel.receive({ type: "refresh" });
  assert.equal(state(panel).state.snapshot.input_request.request_id, "question-1");
  await panel.receive({ type: "cancel-input" });
  assert.deepEqual(requests[0], { session_id: "1", request_id: "question-1", answer: null });
});

test("each ordinary chat creates a new session while sharing remote project startup", async t => {
  const { api, invoke, ready, launches, directory, sessions } = await frontend(t, { existingSession: true });
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 4);
  await Promise.all([invoke("pycodex.newSession"), invoke("pycodex.newSession")]);
  await ready(api.views[0]);
  assert.equal(sessions.size, 3);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].launch, { directory, pythonPath: "", profile: "" });
  assert.equal(api.views.length, 1);
});

test("editing the profile keeps existing sessions running and applies to the next backend", async t => {
  const { api, invoke, ready, launches, directory } = await frontend(t);
  const folder = api.workspace.workspaceFolders[0];
  api.configurations.set(folder.uri.toString(), { pythonPath: "", profile: "step" });
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  assert.deepEqual(launches[0].launch, { directory, pythonPath: "", profile: "step" });
  api.pickResults.push("Profile");
  api.inputResults.push(" next ");
  await view.receive({ type: "settings" });
  assert.equal(api.inputBoxes[0].value, "step");
  assert.match(api.informations[0].message, /原设置.*重新加载.*正在执行的任务会先完成/);
  assert.deepEqual(api.informations[0].actions, ["重新加载窗口"]);
  assert.equal(launches[0].active, true);
  assert.ok(!api.executed.some(call => call[0] === "workbench.action.reloadWindow"));
  await invoke("pycodex.newSession");
  assert.equal(launches.length, 1, "a setting edit does not restart running sessions");
  for (const change of api.folderChanges) change({ removed: [folder], added: [] });
  await invoke("pycodex.newSession");
  assert.deepEqual(launches[1].launch, { directory, pythonPath: "", profile: "next" });
});

test("settings offers Python environments and Profile without starting a backend", async t => {
  const { api, ready, launches } = await frontend(t);
  const view = api.showSidebar();
  await ready(view);
  assert.match(view.webview.html, /~\/\.codex\/config\.toml/);
  assert.match(view.webview.html, /工作区所在机器/);
  await view.receive({ type: "settings" });
  assert.deepEqual(api.quickPicks[0].items.map(item => item.label), ["Python 环境", "Profile"]);
  assert.ok(!api.executed.some(call => call[0] === "workbench.action.openSettings"));
  assert.deepEqual(Object.keys(require("../package.json").contributes.configuration.properties).sort(),
    ["pycodex.profile", "pycodex.pythonPath"]);
  assert.equal(launches.length, 0);
});

test("selecting a project venv validates it and uses it for the first backend", async t => {
  const { api, ready, launches, inspections, directory } = await frontend(t);
  const python = path.join(directory, ".venv",
    ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, "fixture", { mode: 0o755 });
  const view = api.showSidebar();
  await ready(view);
  api.pickResults.push("Python 环境", ".venv");
  await view.receive({ type: "settings" });
  assert.equal(api.quickPicks[1].items.find(item => item.label === ".venv").description, python);
  assert.deepEqual(inspections, [{ directory, python }]);
  assert.deepEqual(api.configurationUpdates, [{
    uri: api.workspace.workspaceFolders[0].uri.toString(),
    key: "pythonPath", value: python, target: api.ConfigurationTarget.Workspace,
  }]);
  assert.equal(launches.length, 0);
  await view.receive({ type: "new-session" });
  await ready(view);
  assert.deepEqual(launches[0].launch, { directory, pythonPath: python, profile: "" });
});

test("browsing Python uses the displayed chat's remote folder and offers reload after a change", async t => {
  const { api, invoke, ready, launches, inspections, directory } = await frontend(t);
  const folder = api.workspace.workspaceFolders[0];
  api.workspace.workspaceFile = folder.uri.with({ path: path.join(directory, "project.code-workspace") });
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  const other = { name: "other", uri: folder.uri.with({ path: directory + "-other" }) };
  api.workspace.workspaceFolders.push(other);
  api.window.activeTextEditor = api.editor(other.uri.with({ path: other.uri.path + "/file.py" }), 0);
  const pythonUri = folder.uri.with({ path: directory + "/custom-env/bin/python" });
  api.pickResults.push("Python 环境", "浏览 Python 解释器…");
  api.openResults.push([pythonUri]);
  api.infoResults.push("重新加载窗口");
  await view.receive({ type: "settings" });
  assert.equal(api.openDialogs[0].defaultUri.toString(), folder.uri.toString());
  assert.equal(api.openDialogs[0].defaultUri.scheme, "vscode-remote");
  assert.deepEqual(inspections, [{ directory, python: pythonUri.fsPath }]);
  assert.deepEqual(api.configurationUpdates, [{
    uri: folder.uri.toString(), key: "pythonPath", value: pythonUri.fsPath,
    target: api.ConfigurationTarget.WorkspaceFolder,
  }]);
  assert.deepEqual(api.executed.at(-1), ["workbench.action.reloadWindow"]);
  assert.equal(launches[0].active, true, "the reload command owns deactivation; the picker never kills a backend");
});

test("an invalid Python selection leaves the saved environment intact and can reopen settings", async t => {
  const { api, ready, launches } = await frontend(t, {
    async inspect() { throw new Error("Selected interpreter is not Python."); },
  });
  const folder = api.workspace.workspaceFolders[0];
  api.configurations.set(folder.uri.toString(), { pythonPath: "/previous/bin/python", profile: "" });
  const view = api.showSidebar();
  await ready(view);
  api.pickResults.push("Python 环境", "浏览 Python 解释器…");
  api.openResults.push([folder.uri.with({ path: "/invalid/python" })]);
  await view.receive({ type: "settings" });
  assert.match(view.messages.at(-1).error, /Selected interpreter is not Python/);
  assert.equal(view.messages.at(-1).retry, "settings");
  assert.equal(api.configurations.get(folder.uri.toString()).pythonPath, "/previous/bin/python");
  assert.deepEqual(api.configurationUpdates, []);
  assert.equal(launches.length, 0);
});

test("cancelling settings preserves values and automatic Python or the default profile can be restored", async t => {
  const { api, ready, inspections } = await frontend(t);
  const folder = api.workspace.workspaceFolders[0];
  api.configurations.set(folder.uri.toString(), { pythonPath: "/previous/bin/python", profile: "step" });
  const view = api.showSidebar();
  await ready(view);
  for (const choices of [[], ["Python 环境"], ["Python 环境", "浏览 Python 解释器…"], ["Profile"]]) {
    api.pickResults.push(...choices);
    await view.receive({ type: "settings" });
  }
  assert.deepEqual(api.configurationUpdates, []);
  api.pickResults.push("Python 环境", "自动检测");
  await view.receive({ type: "settings" });
  api.pickResults.push("Profile");
  api.inputResults.push("");
  await view.receive({ type: "settings" });
  assert.deepEqual(api.configurations.get(folder.uri.toString()), { pythonPath: "", profile: "" });
  assert.deepEqual(inspections, []);
});

test("context usage reaches the sidebar with the backend's remaining percentage", async t => {
  const { api, invoke, sessions, ready } = await frontend(t);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  const usage = {
    usage_tokens: 60000, auto_compact_token_limit: 80000,
    max_context_window: 100000, context_remaining_percent: 25,
  };
  Object.assign(sessions.get("1"), usage);
  await view.receive({ type: "refresh" });
  const snapshot = state(view).state.snapshot;
  for (const [key, value] of Object.entries(usage)) assert.equal(snapshot[key], value);
});

test("closed or unrelated editors do not block ordinary chat or implicitly add context", async t => {
  const { api, invoke, ready, send, requests } = await frontend(t);
  const editor = api.editor("/workspace/first.ts", 0);
  api.window.activeTextEditor = editor;
  await invoke("pycodex.newSession");
  const panel = api.views[0];
  await ready(panel);
  editor.document.isClosed = true;
  await send(panel, "hello");
  assert.equal(requests[0].prompt, "hello");
  api.window.activeTextEditor = api.editor("/outside/second.ts", 5);
  await invoke("pycodex.insertContext");
  assert.equal(api.views.length, 1);
  assert.match(api.errors[0], /Open a source file in a workspace/);
  assert.equal(panel.messages.some(message => message.type === "insert-context"), false);
});

test("commands, empty input and question answers stay plain prompts", async t => {
  const { api, invoke, requests, sessions, ready, send } = await frontend(t);
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 0);
  await invoke("pycodex.newSession");
  const panel = api.views[0];
  for (const text of ["/title New name", "", "/queue", "/model"]) {
    await send(panel, text);
    assert.equal(requests.at(-1).prompt, text);
  }
  sessions.get("1").input_request = { request_id: "r", text: "Choose" };
  await ready(panel);
  await panel.receive({ type: "refresh" });
  await send(panel, "2");
  assert.equal(requests.at(-1).prompt, "2");
  await send(panel, "/queue later");
  assert.equal(requests.at(-1).prompt, "/queue later");
});

test("collapsed chats keep polling and can be expanded without creating or stopping sessions", async t => {
  const { api, invoke, ready, sessions, requests, launches } = await frontend(t);
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 2);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  const first = state(view).sessionKey;
  sessions.get("1").running = true;
  sessions.get("1").status = "talking";
  await view.receive({ type: "refresh" });
  await invoke("pycodex.newSession");
  await ready(view);
  assert.equal(state(view).sessionId, "2");
  assert.equal(state(view).chats[0].running, true);
  sessions.get("1").title = "Working while collapsed";
  sessions.get("1").input_request = { request_id: "background-question", text: "Choose" };
  const deadline = Date.now() + 2_500;
  while (!state(view).chats[0].waitingForInput && Date.now() < deadline) await delay(5);
  assert.equal(state(view).chats[0].title, "Working while collapsed");
  assert.equal(state(view).chats[0].waitingForInput, true);
  await view.receive({ type: "activate-session", targetSessionKey: first });
  assert.equal(state(view).sessionId, "1");
  assert.equal(state(view).expand, true);
  assert.equal(state(view).state.snapshot.running, true);
  assert.equal(sessions.size, 2);
  assert.equal(requests.length, 0);
  assert.equal(launches[0].active, true);
  await view.receive({ type: "activate-session", targetSessionKey: "unknown" });
  assert.match(view.messages.at(-1).error, /Unknown chat session/);
  assert.equal(state(view).sessionId, "1");
});

test("model changes use the ordinary /model command", async t => {
  const { api, invoke, ready, send, requests } = await frontend(t);
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 2);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  await send(view, "/model fixture-next");
  assert.deepEqual(requests[0], { session_id: "1", sender: "vscode", prompt: "/model fixture-next" });
  assert.equal(state(view).state.snapshot.model, "fixture-next");
  await view.receive({ type: "select-model" });
  assert.equal(requests.length, 1);
  assert.match(view.messages.at(-1).error, /Unknown chat action/);
});

test("closing collapsed and active chats removes only those sessions and permits a fresh chat", async t => {
  const { api, invoke, ready, closedSessions, sessions, launches } = await frontend(t);
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 2);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  const first = state(view).sessionKey;
  await invoke("pycodex.newSession");
  await ready(view);
  const second = state(view).sessionKey;
  await view.receive({ type: "close-session", targetSessionKey: first });
  assert.equal(state(view).sessionKey, second);
  assert.deepEqual(state(view).chats.map(chat => chat.sessionId), ["2"]);
  await view.receive({ type: "close-session", targetSessionKey: second });
  assert.equal(state(view).sessionKey, null);
  assert.deepEqual(state(view).chats, []);
  assert.deepEqual(closedSessions, ["1", "2"]);
  assert.equal(sessions.size, 0);
  assert.equal(launches[0].active, true);
  await view.receive({ type: "new-session" });
  await ready(view);
  assert.equal(state(view).sessionId, "3");
});

test("closing a running chat keeps it visible until completion and preserves the other chat", async t => {
  let finish;
  const closeGate = new Promise(resolve => { finish = resolve; });
  t.after(() => finish());
  const { api, invoke, ready, sessions, requests, closedSessions } = await frontend(t, { closeGate });
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 2);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  const first = state(view).sessionKey;
  sessions.get("1").running = true;
  await view.receive({ type: "refresh" });
  await invoke("pycodex.newSession");
  await ready(view);
  const closing = view.receive({ type: "close-session", targetSessionKey: first });
  assert.equal(state(view).chats[0].closing, true);
  assert.equal(state(view).sessionId, "2");
  await view.receive({ type: "activate-session", targetSessionKey: first });
  await view.receive({ type: "submit", text: "too late", queue: false, requestId: "late" });
  assert.equal(requests.length, 0);
  assert.match(view.messages.at(-1).error, /Session is closing/);
  finish();
  await closing;
  assert.deepEqual(closedSessions, ["1"]);
  assert.equal(state(view).sessionId, "2");
  assert.equal(state(view).expand, true);
  assert.equal(sessions.get("2").accepts_input, true);
});

test("a rejected close remains visible with its error and is not retried", async t => {
  const { api, invoke, ready, sessions, closedSessions } = await frontend(t, { closeError: "cannot close the last session" });
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 2);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  await view.receive({ type: "close-session", targetSessionKey: state(view).sessionKey });
  assert.equal(state(view).state.closing, false);
  assert.match(state(view).state.error, /cannot close the last session/);
  assert.equal(state(view).chats.length, 1);
  assert.equal(sessions.size, 1);
  assert.deepEqual(closedSessions, ["1"]);
});

test("webview resources are restricted, forged sessions cannot reroute sends, and command links are rejected", async t => {
  const { api, invoke, ready, requests } = await frontend(t);
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 0);
  await invoke("pycodex.newSession");
  const panel = api.views[0];
  await ready(panel);
  assert.equal(panel.webview.options.enableCommandUris, undefined);
  assert.equal(panel.webview.options.enableForms, false);
  assert.equal(panel.webview.options.localResourceRoots.length, 2);
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.match(panel.webview.html, /connect-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|<editor_context>/);
  await panel.receive({ type: "submit", sessionId: "other", text: "hello", queue: false, requestId: "r" });
  assert.equal(requests[0].session_id, "1");
  await panel.receive({ type: "submit", text: 42, queue: false, requestId: "invalid" });
  assert.equal(requests.length, 1);
  assert.match(panel.messages.at(-1).error, /Invalid chat submission/);
  const commandsBefore = api.executed.length;
  await panel.receive({ type: "open-link", href: "command:workbench.action.terminal.new" });
  assert.equal(api.executed.length, commandsBefore);
  assert.match(panel.messages.at(-1).error, /只能打开/);
  await panel.receive({ type: "open-link", href: "https://example.com/docs" });
  assert.equal(api.external.length, 1);
  await panel.receive({ type: "open-link", href: "README.md" });
  assert.equal(api.executed.at(-1)[0], "vscode.open");
  assert.equal(api.executed.at(-1)[1].toString(),
    api.workspace.workspaceFolders[0].uri.toString() + "/README.md");
});

test("the hidden sidebar reattaches with fresh state without stopping the project", async t => {
  const { api, invoke, ready, sessions, launches } = await frontend(t);
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 0);
  await invoke("pycodex.newSession");
  const panel = api.views[0];
  await ready(panel);
  panel.setVisible(false);
  sessions.get("1").title = "Updated while hidden";
  const before = panel.messages.length;
  panel.show();
  await delay(20);
  assert.equal(panel.messages.length, before);
  await panel.receive({ type: "ready" });
  assert.equal(state(panel).state.snapshot.title, "Updated while hidden");
  panel.dispose();
  assert.equal(launches[0].active, true);
  const folder = api.workspace.getWorkspaceFolder(api.editor("/workspace/first.ts", 0).document.uri);
  for (const change of api.folderChanges) change({ removed: [folder], added: [] });
  assert.equal(launches[0].active, false);
});

test("opening the activity-bar view shows a welcome screen and creates a session only on request", async t => {
  const { api, ready, launches, sessions } = await frontend(t);
  const view = api.showSidebar();
  await ready(view);
  assert.equal(state(view).sessionKey, null);
  assert.equal("source" in state(view), false);
  assert.equal(launches.length, 0);
  await view.receive({ type: "new-session" });
  await ready(view);
  assert.equal(state(view).sessionId, "1");
  assert.equal(sessions.size, 1);
  view.setVisible(false);
  api.showSidebar();
  await ready(view);
  assert.equal(sessions.size, 1);
});

test("retrying a failed backend startup creates a session instead of refreshing a missing session", async t => {
  let attempts = 0;
  const { api, ready, launches, sessions } = await frontend(t, {
    async prepare() {
      if (++attempts === 1) throw new Error("Backend version unavailable.\nFixture pip diagnostics.");
    },
  });
  const view = api.showSidebar();
  await ready(view);
  await view.receive({ type: "new-session" });
  const failure = view.messages.at(-1);
  assert.equal(failure.type, "action-error");
  assert.equal(failure.sessionKey, null);
  assert.equal(failure.retry, "new-session");
  assert.match(failure.error, /Fixture pip diagnostics/);
  assert.equal(sessions.size, 0);
  assert.equal(launches[0].active, false);
  await view.receive({ type: failure.retry });
  await ready(view);
  assert.equal(attempts, 2);
  assert.equal(launches.length, 2);
  assert.equal(sessions.size, 1);
  assert.equal(state(view).sessionId, "1");
});

test("a stale sidebar action cannot submit into the newly selected session", async t => {
  const { api, invoke, ready, requests } = await frontend(t);
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 2);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  const previous = state(view).sessionKey;
  await invoke("pycodex.newSession");
  await ready(view);
  await view.receive({ type: "submit", sessionKey: previous, text: "old draft", queue: false, requestId: "r" });
  assert.equal(requests.length, 0);
  assert.equal(view.messages.at(-1).sessionKey, previous);
  assert.match(view.messages.at(-1).error, /对话已切换/);
  const before = view.messages.filter(message => message.type === "insert-context").length;
  await view.receive({ type: "insert-context", sessionKey: previous });
  assert.equal(view.messages.filter(message => message.type === "insert-context").length, before);
});

test("a send finishing after a sidebar switch stays in its original session", async t => {
  let release;
  const messageGate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { api, invoke, ready, requests } = await frontend(t, { messageGate });
  api.window.activeTextEditor = api.editor("/workspace/first.ts", 2);
  await invoke("pycodex.newSession");
  const view = api.views[0];
  await ready(view);
  const previous = state(view).sessionKey;
  const sending = view.receive({ type: "submit", text: "first message", queue: false, requestId: "pending" });
  const deadline = Date.now() + 2_000;
  while (!requests.length && Date.now() < deadline) await delay(5);
  assert.equal(requests.length, 1);
  api.window.activeTextEditor = api.editor("/workspace/second.ts", 8);
  await invoke("pycodex.newSession");
  await ready(view);
  release();
  await sending;
  assert.equal(requests[0].session_id, "1");
  assert.equal(requests[0].prompt, "first message");
  assert.equal(state(view).sessionId, "2");
  assert.equal(state(view).state.snapshot.turns.length, 0);
  assert.deepEqual(view.messages.at(-1), { type: "sent", sessionKey: previous, requestId: "pending" });
});

test("a remote workspace cannot activate this extension in the local UI host", async t => {
  const { api, activate } = await frontend(t);
  const subscriptions = [];
  activate({ extension: { extensionKind: api.ExtensionKind.UI }, subscriptions });
  assert.equal(subscriptions.length, 0);
  assert.match(api.errors[0], /remote workspace extension host/);
  assert.deepEqual(require("../package.json").extensionKind, ["workspace"]);
});
