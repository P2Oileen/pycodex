const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { BackendClient, BackendError } = require("../out/backend");

async function server(t, handler) {
  const instance = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    handler(request, response, body ? JSON.parse(body) : undefined);
  });
  await new Promise(resolve => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => {
    instance.close(resolve);
    instance.closeAllConnections();
  }));
  return `http://127.0.0.1:${instance.address().port}`;
}

function json(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

test("workspace paths and explicit session ids are used for reads, sends, answers and closing", async t => {
  const calls = [];
  const origin = await server(t, (request, response, body) => {
    calls.push({ path: request.url, method: request.method, body });
    json(response, { sessions: [{ id: "a" }], session_id: "new", ok: true });
  });
  const client = new BackendClient(`${origin}/w/project/`);
  assert.deepEqual(await client.listSessions(), [{ id: "a" }]);
  assert.equal((await client.createSession()).session_id, "new");
  await client.snapshot("a /?");
  await client.submit("b", "/queue explain\n\nfile: current.py\nline: 12");
  await client.answer("c", "question-id", null);
  await client.closeSession("d /?");
  assert.deepEqual(calls, [
    { path: "/w/project/api/sessions", method: "GET", body: undefined },
    { path: "/w/project/api/sessions", method: "POST", body: {} },
    { path: "/w/project/api/session?session_id=a%20%2F%3F", method: "GET", body: undefined },
    {
      path: "/w/project/api/session/message", method: "POST",
      body: {
        session_id: "b", sender: "vscode", prompt: "/queue explain\n\nfile: current.py\nline: 12",
      },
    },
    {
      path: "/w/project/api/session/message", method: "POST",
      body: { session_id: "c", request_id: "question-id", answer: null },
    },
    { path: "/w/project/api/sessions/d%20%2F%3F", method: "DELETE", body: undefined },
  ]);
});

test("failed submissions are visible and never automatically retried", async t => {
  let count = 0;
  const origin = await server(t, (_request, response) => {
    count += 1;
    json(response, { error: "agent is shutting down" }, 400);
  });
  await assert.rejects(
    new BackendClient(origin).submit("session", "explain\n\nline: 2"),
    error => error instanceof BackendError &&
      error.status === 400 &&
      error.message === `agent is shutting down (${origin}/api/session/message)`,
  );
  assert.equal(count, 1);
});

test("redirects are not followed and credential-bearing configuration is rejected", async t => {
  let redirected = false;
  const destination = await server(t, (_request, response) => {
    redirected = true;
    json(response, {});
  });
  const origin = await server(t, (_request, response) => {
    response.writeHead(302, { Location: destination });
    response.end();
  });
  await assert.rejects(new BackendClient(origin).listSessions());
  assert.equal(redirected, false);
  assert.throws(() => new BackendClient("http://user:password@localhost/w/project"));
  assert.throws(() => new BackendClient(`${origin}?token=fixture`));
  assert.throws(() => new BackendClient("file:///workspace"));
});

test("a stopped project's client cannot send to a reused address", async t => {
  let requests = 0;
  const origin = await server(t, (_request, response) => {
    requests++;
    json(response, { ok: true });
  });
  const lifetime = new AbortController();
  const client = new BackendClient(origin, lifetime.signal);
  lifetime.abort();
  await assert.rejects(client.submit("s", "hello"), /backend has stopped/);
  assert.equal(requests, 0);
});

test("connection failures identify the project endpoint", async () => {
  const instance = http.createServer();
  await new Promise(resolve => instance.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${instance.address().port}`;
  await new Promise(resolve => instance.close(resolve));
  await assert.rejects(new BackendClient(origin).listSessions(), error => {
    assert.ok(error.message.includes(origin));
    assert.match(error.message, /project's pycodex-ws/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
});
