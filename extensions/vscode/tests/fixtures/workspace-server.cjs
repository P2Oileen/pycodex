const http = require("node:http");
const fs = require("node:fs/promises");
const { createInterface } = require("node:readline");

async function main() {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  const mode = option("--fixture-mode");
  if (option("--workspace-config") === "-" || args.includes("--shutdown-on-stdin-eof")) {
    throw new Error("The fixture uses a config file and default stdin ownership, without an exit flag.");
  }
  const owner = createInterface({ input: process.stdin });
  let ownerClosed = false;
  let server;
  let stall;
  owner.once("close", () => {
    ownerClosed = true;
    clearInterval(stall);
    server?.close();
  });
  const config = JSON.parse(await fs.readFile(option("--workspace-config"), "utf8"));
  if (mode === "fail") {
    process.stderr.write("fixture startup failed\napi_key=fixture-sensitive-value\n");
    process.exitCode = 3;
    process.stdin.destroy();
    owner.close();
    return;
  }
  if (mode === "stall") {
    if (!ownerClosed) stall = setInterval(() => {}, 1_000);
    return;
  }
  let sessions = 0;
  server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/workspaces") {
      response.statusCode = mode === "unauthorized" ? 401 : 200;
      response.end(JSON.stringify(config));
    } else if (request.url.endsWith("/fixture")) {
      response.end(JSON.stringify({
        pid: process.pid, cwd: process.cwd(), args, config,
      }));
    } else if (request.method === "POST") {
      response.end(JSON.stringify({ session_id: String(++sessions), snapshot: {} }));
    } else {
      response.end(JSON.stringify({ sessions: [] }));
    }
  });
  const [host, port] = option("--listen").split(":");
  await new Promise(resolve => server.listen(Number(port), host, resolve));
  if (ownerClosed) server.close();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
