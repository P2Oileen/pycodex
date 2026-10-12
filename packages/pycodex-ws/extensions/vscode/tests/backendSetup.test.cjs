const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { BackendSetup, meetsMinimumVersion, projectPythons, pythonFromLauncher } = require("../out/backendSetup");

test("minimum backend versions follow Python prerelease, postrelease and local-version ordering", () => {
  for (const version of [null, "0.2.9", "0.3.0", "0.3.1.dev1", "0.3.1rc1", "0.3.1a2.post1"]) {
    assert.equal(meetsMinimumVersion(version, "0.3.1"), false, String(version));
  }
  for (const version of ["0.3.1", "0.3.1.0", "0.3.1+local", "0.3.1.post0.dev1", "0.3.1.post1", "0.3.2.dev0", "0.10.0", "1!0.1"]) {
    assert.equal(meetsMinimumVersion(version, "0.3.1"), true, version);
  }
  assert.throws(() => meetsMinimumVersion("unknown", "0.3.1"), /Invalid.*version/);
});

test("Python is read from pip/uv launchers without resolving virtualenv interpreter symlinks", () => {
  const launchers = [
    ["#!/project/.venv/bin/python3\nimport sys\n", "/project/.venv/bin/python3"],
    ["#!/usr/bin/env python3\n", "python3"],
    ["#!/bin/sh\n'''exec' \"/project with spaces/.venv/bin/python\" \"$0\" \"$@\"\n' '''\n", "/project with spaces/.venv/bin/python"],
    ["#!/bin/sh\n'''exec' /long/path/bin/python3 \"$0\" \"$@\"\n' '''\n", "/long/path/bin/python3"],
    ['MZbinary-launcher#!"C:\\Python Env\\python.exe"\nPK\x03\x04zip', "C:\\Python Env\\python.exe"],
    ["MZbinary-launcher#!C:\\Python\\python.exe\r\nPK\x03\x04zip", "C:\\Python\\python.exe"],
  ];
  for (const [launcher, expected] of launchers) {
    assert.equal(pythonFromLauncher(Buffer.from(launcher)), expected);
  }
  for (const launcher of ["#!/bin/bash\nexec uv run pycodex-ws\n", "MZunknown", "#!/usr/bin/node\n"]) {
    assert.throws(() => pythonFromLauncher(Buffer.from(launcher)), /Cannot identify.*interpreter/);
  }
});

// Real subprocesses exercise discovery, pip invocation and post-install checks.
// The fixture is a POSIX executable; Windows launcher parsing is covered above.
const processTest = (name, action) => test(name, { skip: process.platform === "win32" }, action);

async function fixture(t, state = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pycodex Python-测试-"));
  const bin = path.join(directory, "bin");
  await fs.mkdir(bin);
  const python = path.join(bin, "python3");
  const command = path.join(bin, "pycodex-ws");
  const body = await fs.readFile(path.join(__dirname, "fixtures", "python.cjs"), "utf8");
  await fs.writeFile(python, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  await fs.writeFile(command, `#!${python}\n`, { mode: 0o755 });
  const statePath = path.join(bin, "environment.json");
  await fs.writeFile(statePath, JSON.stringify({ version: "0.4.0", ...state }));
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(async () => {
    process.env.PATH = previousPath;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const messages = [];
  const setup = new BackendSetup();
  const options = { directory, pythonPath: "", profile: "step" };
  return {
    directory, bin, python, command, statePath, messages, setup, options,
    expectedLaunch: { directory, command: python, args: ["-m", "workspace_server", "--profile", "step"] },
    prepare: launch => setup.prepare(launch || options, message => messages.push(message)),
    async calls() {
      return (await fs.readFile(path.join(bin, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    },
  };
}

processTest("compatible PATH installations are reused without invoking pip", async t => {
  const f = await fixture(t, { version: "0.4.0" });
  assert.deepEqual(await f.prepare(), f.expectedLaunch);
  assert.deepEqual(await f.calls(), [{ kind: "check" }]);
  assert.equal(f.messages.at(-1), "Starting the Python backend…");
});

processTest("an old backend upgrades the selected interpreter and preserves the profile", async t => {
  const f = await fixture(t, { version: "0.3.3" });
  process.env.PATH = "";
  assert.deepEqual(await f.prepare({ ...f.options, pythonPath: f.python }), f.expectedLaunch);
  assert.deepEqual(await f.calls(), [
    { kind: "check" },
    { kind: "pip", args: [
      "-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "--no-input", "pycodex-ws>=0.4.0",
    ] },
    { kind: "check" },
  ]);
  assert.ok(f.messages.some(message => message.startsWith("Upgrading")));
});

processTest("workspace upgrades resolve the matching core through its dependency", async t => {
  const f = await fixture(t, { version: "0.3.0" });
  await f.prepare();
  const installing = (await f.calls()).find(call => call.kind === "pip");
  assert.deepEqual(installing.args.slice(-2), ["--no-input", "pycodex-ws>=0.4.0"]);
});

processTest("an existing pycodex CLI selects its environment when pycodex-ws is absent", async t => {
  const f = await fixture(t, { version: null });
  await fs.rename(f.command, path.join(f.bin, "pycodex"));
  assert.deepEqual(await f.prepare(), f.expectedLaunch);
  assert.equal((await f.calls()).filter(call => call.kind === "pip").length, 1);
});

processTest("a missing package is installed with available Python and runs without a PATH refresh", async t => {
  const f = await fixture(t, { version: null });
  await fs.unlink(f.command);
  assert.deepEqual(await f.prepare(), f.expectedLaunch);
  assert.ok(f.messages.some(message => message.startsWith("Installing")));
  assert.equal((await f.calls()).filter(call => call.kind === "pip").length, 1);
});

processTest("an installed package without a console script on PATH still needs no pip", async t => {
  const f = await fixture(t);
  await fs.unlink(f.command);
  const launch = await f.prepare();
  assert.equal(launch.command, f.python);
  assert.deepEqual(launch.args.slice(0, 2), ["-m", "workspace_server"]);
  assert.deepEqual(await f.calls(), [{ kind: "check" }]);
});

processTest("an invalid selected interpreter and missing Python fail instead of changing environments", async t => {
  const f = await fixture(t);
  await assert.rejects(
    f.prepare({ ...f.options, pythonPath: path.join(f.directory, "missing") }),
    /找不到所选的 Python.*远端/s,
  );
  assert.deepEqual(await fs.readdir(f.bin), ["environment.json", "pycodex-ws", "python3"]);
  process.env.PATH = "";
  await assert.rejects(f.prepare(), /Python was not found.*remote server/s);
});

processTest("an empty selected venv is installed and launched without touching the PATH environment", async t => {
  const f = await fixture(t);
  const bin = path.join(f.directory, "selected venv", "bin");
  await fs.mkdir(bin, { recursive: true });
  const python = path.join(bin, "python");
  await fs.copyFile(f.python, python);
  await fs.writeFile(path.join(bin, "environment.json"), JSON.stringify({ version: null }));
  const launch = await f.prepare({
    ...f.options, pythonPath: path.relative(f.directory, python), profile: "",
  });
  assert.deepEqual(launch, { directory: f.directory, command: python, args: ["-m", "workspace_server"] });
  const calls = (await fs.readFile(path.join(bin, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map(call => call.kind), ["check", "pip", "check"]);
  await assert.rejects(f.calls(), { code: "ENOENT" });
});

processTest("validating an empty venv does not install Pycodex", async t => {
  const f = await fixture(t, { version: null });
  const environment = await f.setup.inspect(f.directory, f.python);
  assert.equal(environment.python, f.python);
  assert.equal(environment.version, null);
  assert.deepEqual(await f.calls(), [{ kind: "check" }]);
});

processTest("project venv discovery preserves interpreter symlinks and ignores unrelated environments", async t => {
  const f = await fixture(t);
  const expected = [];
  for (const name of [".venv", "venv", "other"]) {
    const bin = path.join(f.directory, name, "bin");
    await fs.mkdir(bin, { recursive: true });
    const python = path.join(bin, "python");
    await fs.symlink(f.python, python);
    if (name !== "other") expected.push(python);
  }
  assert.deepEqual(await projectPythons(f.directory), expected);
  await fs.unlink(expected[0]);
  assert.deepEqual(await projectPythons(f.directory), expected.slice(1));
});

processTest("pip failures stay visible with credentials removed and no fallback installation", async t => {
  const f = await fixture(t, {
    version: "0.3.0",
    installError: "externally-managed-environment\napi_key=fixture-sensitive\nhttps://user:fixture-password@example.test/?token=fixture-token\nhttps://fixture-credential@example.test/simple/",
  });
  await assert.rejects(f.prepare(), error => {
    assert.ok(error.message.includes(f.python));
    assert.match(error.message, /externally-managed-environment/);
    assert.match(error.message, /\[redacted\]/);
    assert.doesNotMatch(error.message, /fixture-sensitive|fixture-password|fixture-token|fixture-credential/);
    return true;
  });
  assert.equal((await f.calls()).length, 2);
});

for (const requirement of ["python-codex==0.4.0", "pycodex-ws>=0.4.0", "some-dependency>=1.0"]) {
  processTest(`missing ${requirement} keeps pip diagnostics behind an actionable installation error`, async t => {
    const details = [
      "Looking in indexes: https://packages.example.test/simple/",
      `ERROR: Could not find a version that satisfies the requirement ${requirement}`,
      `ERROR: No matching distribution found for ${requirement}`,
    ].join("\n");
    const f = await fixture(t, { version: "0.3.0", installError: details });
    await assert.rejects(f.prepare(), error => {
      const summary = error.message.split("\n")[0];
      assert.match(summary, /Pycodex 安装失败.*重试.*设置/);
      assert.doesNotMatch(summary, /发布|同步|>=/);
      assert.ok(!summary.includes(f.python));
      assert.ok(error.message.includes(`Python: ${f.python}`));
      assert.ok(error.message.includes(details));
      return true;
    });
    assert.equal((await f.calls()).length, 2);
    assert.ok(!f.messages.includes("Starting the Python backend…"));
  });
}

processTest("pip success is checked against the actual installed version before startup", async t => {
  const f = await fixture(t, { version: "0.2.0", nextVersion: "0.3.0" });
  await assert.rejects(f.prepare(), /pip finished.*0\.3\.0.*0\.4\.0/s);
  assert.ok(!f.messages.includes("Starting the Python backend…"));
});

processTest("concurrent projects share one installation in the same Python environment", async t => {
  const f = await fixture(t, { version: "0.3.0", installDelay: 200 });
  await Promise.all([
    f.prepare(),
    f.prepare({ ...f.options, pythonPath: f.python, directory: f.bin }),
  ]);
  assert.equal((await f.calls()).filter(call => call.kind === "pip").length, 1);
});

processTest("python and python3 aliases of one environment share the same pip installation", async t => {
  const f = await fixture(t, { version: "0.3.0", installDelay: 200 });
  const alias = path.join(f.bin, "python");
  await fs.copyFile(f.python, alias);
  await Promise.all([f.prepare(), f.prepare({ ...f.options, pythonPath: alias })]);
  assert.equal((await f.calls()).filter(call => call.kind === "pip").length, 1);
});

processTest("a failed installation can be retried after the environment is repaired", async t => {
  const f = await fixture(t, { version: "0.3.0", installError: "No module named pip" });
  await assert.rejects(f.prepare(), /No module named pip/);
  await fs.writeFile(f.statePath, JSON.stringify({ version: "0.3.0" }));
  assert.equal((await f.prepare()).command, f.python);
  assert.equal((await f.calls()).filter(call => call.kind === "pip").length, 2);
});
