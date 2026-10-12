const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { WorkspaceProcess } = require("../out/workspaceProcess");

async function launch(t, mode = "ready", timeout = 3_000, missing = false) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pycodex project-测试-")));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "pycodex-storage-"));
  const configPath = path.join(storage, "project", "workspaces.json");
  const options = {
    directory,
    command: missing ? path.join(directory, "missing-command") : process.execPath,
    args: [path.join(__dirname, "fixtures", "workspace-server.cjs"), "--fixture-mode", mode],
  };
  const workspace = new WorkspaceProcess(options, configPath, timeout);
  t.after(async () => {
    workspace.dispose();
    await workspace.closed;
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(storage, { recursive: true, force: true });
  });
  return { workspace, directory, configPath, options };
}

test("project processes use separate ports and retain private config files after shutdown", async t => {
  const first = await launch(t);
  const second = await launch(t);
  const [a, b] = await Promise.all([first.workspace.ready, second.workspace.ready]);
  assert.notEqual(a.url, b.url);
  const info = await (await fetch(`${a.url}/fixture`)).json();
  assert.equal(info.cwd, first.directory);
  assert.notEqual(info.pid, process.pid);
  assert.deepEqual(info.config, {
    workspaces: [{
      id: "vscode",
      work_dir: first.directory,
      state_path: "workspaces.vscode",
      enable_board: false,
    }],
  });
  const configPath = info.args[info.args.indexOf("--workspace-config") + 1];
  assert.equal(configPath, first.configPath);
  assert.notEqual(configPath, second.configPath);
  assert.notEqual(configPath, "-");
  assert.ok(path.isAbsolute(configPath));
  assert.ok(!configPath.startsWith(first.directory + path.sep));
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), info.config);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.dirname(configPath))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  }
  assert.ok(!info.args.includes("--shutdown-on-stdin-eof"));
  assert.ok(info.args.some(value => /^127\.0\.0\.1:\d+$/.test(value)));
  assert.ok(!info.args.includes("--password"));
  assert.equal((await a.createSession()).session_id, "1");
  assert.equal((await a.createSession()).session_id, "2");
  first.workspace.dispose();
  await first.workspace.closed;
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), info.config);
  await assert.rejects(a.submit("1", "stale request"), /backend has stopped/);
  assert.deepEqual(await fs.readdir(first.directory), []);
  assert.equal(second.workspace.active, true);
  assert.deepEqual(await b.listSessions(), []);
});

test("restarting a project reuses its config without overwriting it", async t => {
  const { workspace, configPath, options } = await launch(t);
  await workspace.ready;
  workspace.dispose();
  await workspace.closed;
  const saved = JSON.stringify(JSON.parse(await fs.readFile(configPath, "utf8")), null, 2) + "\n";
  await fs.writeFile(configPath, saved);
  const restarted = new WorkspaceProcess(options, configPath, 3_000);
  try {
    const backend = await restarted.ready;
    const info = await (await fetch(`${backend.url}/fixture`)).json();
    assert.equal(info.args[info.args.indexOf("--workspace-config") + 1], configPath);
    assert.equal(await fs.readFile(configPath, "utf8"), saved);
  } finally {
    restarted.dispose();
    await restarted.closed;
  }
  assert.equal(await fs.readFile(configPath, "utf8"), saved);
});

test("an invalid saved config fails visibly and remains intact", async t => {
  const { workspace, configPath, options } = await launch(t);
  await workspace.ready;
  workspace.dispose();
  await workspace.closed;
  await fs.writeFile(configPath, "{unfinished");
  const restarted = new WorkspaceProcess(options, configPath, 3_000);
  await assert.rejects(restarted.ready, /SyntaxError|JSON/);
  await restarted.closed;
  assert.equal(await fs.readFile(configPath, "utf8"), "{unfinished");
});

test("missing executables report the remote host setting", async t => {
  const { workspace, configPath } = await launch(t, "ready", 3_000, true);
  await assert.rejects(workspace.ready, /Python environment.*remote server/s);
  await workspace.closed;
  assert.equal(workspace.active, false);
  assert.ok((await fs.stat(configPath)).isFile());
});

test("startup failure surfaces diagnostics with credentials redacted", async t => {
  const { workspace, configPath } = await launch(t, "fail");
  await assert.rejects(workspace.ready, error => {
    assert.match(error.message, /fixture startup failed/);
    assert.match(error.message, /api_key=\[redacted\]/);
    assert.ok(!error.message.includes("fixture-sensitive-value"));
    return true;
  });
  await workspace.closed;
  assert.ok((await fs.stat(configPath)).isFile());
});

test("HTTP authentication failures stop startup", async t => {
  const { workspace } = await launch(t, "unauthorized");
  await assert.rejects(workspace.ready, /HTTP 401/);
  await workspace.closed;
  assert.equal(workspace.active, false);
});

test("a stalled startup times out and closes its child", async t => {
  const { workspace } = await launch(t, "stall", 400);
  await assert.rejects(workspace.ready, /did not start/);
  await workspace.closed;
  assert.equal(workspace.active, false);
});

test("disposing during startup cannot leave a child running", async t => {
  const { workspace } = await launch(t);
  workspace.dispose();
  await assert.rejects(workspace.ready, /project has closed/);
  await workspace.closed;
  assert.equal(workspace.active, false);
});

test("package preparation has its own lifetime before the backend startup timeout", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pycodex-prepare-"));
  const prepared = delay(500).then(() => ({
    directory, command: process.execPath,
    args: [path.join(__dirname, "fixtures", "workspace-server.cjs"), "--fixture-mode", "ready"],
  }));
  const workspace = new WorkspaceProcess(prepared, path.join(directory, "workspaces.json"), 300);
  t.after(async () => {
    workspace.dispose();
    await workspace.closed;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const backend = await workspace.ready;
  assert.equal((await backend.createSession()).session_id, "1");
});

test("closing during installation waits for it and prevents a backend from starting", async () => {
  let finish;
  const preparation = new Promise(resolve => { finish = resolve; });
  const workspace = new WorkspaceProcess(preparation, path.join(os.tmpdir(), "must-not-create.json"));
  let closed = false;
  void workspace.closed.then(() => { closed = true; });
  workspace.dispose();
  await delay(10);
  assert.equal(closed, false);
  finish({ directory: os.tmpdir(), command: "must-not-start", args: [] });
  await assert.rejects(workspace.ready, /project has closed/);
  await workspace.closed;
  assert.equal(closed, true);
});

test("a preparation error closes the workspace and remains visible", async () => {
  const workspace = new WorkspaceProcess(
    Promise.reject(new Error("pip cannot write to this environment")),
    path.join(os.tmpdir(), "must-not-create.json"),
  );
  await assert.rejects(workspace.ready, /pip cannot write/);
  await workspace.closed;
  assert.equal(workspace.active, false);
});
