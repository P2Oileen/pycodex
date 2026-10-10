const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { WorkspaceProcess } = require("../out/workspaceProcess");

async function launch(t, mode = "ready", timeout = 3_000, missing = false) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pycodex project-测试-")));
  const workspace = new WorkspaceProcess({
    directory,
    command: missing ? path.join(directory, "missing-command") : process.execPath,
    args: [path.join(__dirname, "fixtures", "workspace-server.cjs"), "--fixture-mode", mode],
  }, timeout);
  t.after(async () => {
    workspace.dispose();
    await workspace.closed;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { workspace, directory };
}

test("project processes use separate ports and private config files and clean up only their own backend", async t => {
  const first = await launch(t);
  const second = await launch(t);
  const [a, b] = await Promise.all([first.workspace.ready, second.workspace.ready]);
  assert.notEqual(a.url, b.url);
  const info = await (await fetch(`${a.url}/fixture`)).json();
  assert.equal(info.cwd, first.directory);
  assert.notEqual(info.pid, process.pid);
  assert.deepEqual(info.config, {
    workspaces: [{ id: "vscode", work_dir: first.directory, board: false }],
  });
  const configPath = info.args[info.args.indexOf("--workspace-config") + 1];
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
  await assert.rejects(fs.stat(path.dirname(configPath)), { code: "ENOENT" });
  await assert.rejects(a.submit("1", "stale request"), /backend has stopped/);
  assert.deepEqual(await fs.readdir(first.directory), []);
  assert.equal(second.workspace.active, true);
  assert.deepEqual(await b.listSessions(), []);
});

test("missing executables report the remote host setting", async t => {
  const { workspace } = await launch(t, "ready", 3_000, true);
  await assert.rejects(workspace.ready, /Python environment.*remote server/s);
  await workspace.closed;
  assert.equal(workspace.active, false);
  await assert.rejects(fs.stat(workspace.configDirectory), { code: "ENOENT" });
});

test("startup failure surfaces diagnostics with credentials redacted", async t => {
  const { workspace } = await launch(t, "fail");
  await assert.rejects(workspace.ready, error => {
    assert.match(error.message, /fixture startup failed/);
    assert.match(error.message, /api_key=\[redacted\]/);
    assert.ok(!error.message.includes("fixture-sensitive-value"));
    return true;
  });
  await workspace.closed;
  await assert.rejects(fs.stat(workspace.configDirectory), { code: "ENOENT" });
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
  const workspace = new WorkspaceProcess(prepared, 300);
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
  const workspace = new WorkspaceProcess(preparation);
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
  const workspace = new WorkspaceProcess(Promise.reject(new Error("pip cannot write to this environment")));
  await assert.rejects(workspace.ready, /pip cannot write/);
  await workspace.closed;
  assert.equal(workspace.active, false);
});
