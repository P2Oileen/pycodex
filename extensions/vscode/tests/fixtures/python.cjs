const fs = require("node:fs");
const path = require("node:path");

const directory = path.dirname(process.argv[1]);
const statePath = path.join(directory, "environment.json");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const checking = args.includes("-c");
fs.appendFileSync(path.join(directory, "calls.jsonl"), JSON.stringify(
  checking ? { kind: "check" } : { kind: "pip", args },
) + "\n");

if (checking) {
  process.stdout.write(JSON.stringify({
    python: process.argv[1], sitePackages: path.join(directory, "site-packages"),
    version: state.version,
  }) + "\n");
} else if (args[0] === "-m" && args[1] === "pip" && args[2] === "install") {
  setTimeout(() => {
    if (state.installError) {
      process.stderr.write(state.installError + "\n");
      process.exitCode = 1;
    } else {
      state.version = state.nextVersion || "0.4.0";
      fs.writeFileSync(statePath, JSON.stringify(state));
      process.stdout.write("Successfully installed pycodex-ws\n");
    }
  }, state.installDelay || 0);
} else {
  throw new Error("Unexpected Python invocation.");
}
