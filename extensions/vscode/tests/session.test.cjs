const assert = require("node:assert/strict");
const { setImmediate } = require("node:timers/promises");
const { test } = require("node:test");
const { SessionConnection } = require("../out/session");

function snapshot(title) {
  return {
    title, model: "fixture", turns: [], queued_inputs: [],
    running: false, status: "", accepts_input: true, input_request: null,
    context_remaining_percent: 100, recorded_rollout_path: null,
  };
}

function backend() {
  const reads = [];
  const writes = [];
  return {
    reads, writes, url: "http://localhost/w/project",
    snapshot(id, signal) {
      return new Promise((resolve, reject) => {
        reads.push({ id, signal, resolve, reject });
      });
    },
    async submit(id, text) {
      writes.push({ id, text });
    },
    async answer(id, requestId, answer) {
      writes.push({ id, requestId, answer });
    },
  };
}

test("late polls cannot replace a newer snapshot, including late errors", async t => {
  const client = backend();
  const connection = new SessionConnection(client, "a");
  t.after(() => connection.dispose());
  const states = [];
  connection.subscribe(state => states.push(state));
  const newer = connection.refresh();
  assert.equal(client.reads[0].signal.aborted, true);
  client.reads[1].resolve({ session_id: "a", snapshot: snapshot("newer") });
  await newer;
  client.reads[0].reject(new Error("late error"));
  await setImmediate();
  assert.equal(connection.state.snapshot.title, "newer");
  assert.equal(connection.state.error, undefined);
  assert.equal(states.at(-1).snapshot.title, "newer");
});

test("multiple sessions keep their reads, submissions, and lifetimes separate", async t => {
  const client = backend();
  const first = new SessionConnection(client, "first");
  const second = new SessionConnection(client, "second");
  t.after(() => { first.dispose(); second.dispose(); });
  first.subscribe(() => {});
  second.subscribe(() => {});
  client.reads[0].resolve({ session_id: "first", snapshot: snapshot("First") });
  client.reads[1].resolve({ session_id: "second", snapshot: snapshot("Second") });
  await setImmediate();
  first.dispose();
  const sending = second.submit("explain\n\nfile: second.py\nline: 7");
  await setImmediate();
  assert.deepEqual(client.writes, [
    { id: "second", text: "explain\n\nfile: second.py\nline: 7" },
  ]);
  assert.equal(client.reads[2].id, "second");
  client.reads[2].resolve({ session_id: "second", snapshot: snapshot("Updated second") });
  await sending;
  assert.equal(first.state.snapshot.title, "First");
  assert.equal(second.state.snapshot.title, "Updated second");
});

test("a pre-submission poll cannot overwrite the result of a send", async t => {
  const client = backend();
  const connection = new SessionConnection(client, "a");
  t.after(() => connection.dispose());
  connection.subscribe(() => {});
  const sending = connection.submit("hello\n\nline: 3");
  await setImmediate();
  assert.equal(connection.state.submitting, true);
  client.reads[1].resolve({ session_id: "a", snapshot: snapshot("After send") });
  await sending;
  client.reads[0].resolve({ session_id: "a", snapshot: snapshot("Before send") });
  await setImmediate();
  assert.equal(connection.state.snapshot.title, "After send");
  assert.equal(connection.state.submitting, false);
});

test("disposing a view during an accepted send stops observation without closing the session", async () => {
  const client = backend();
  let finish;
  client.submit = () => new Promise(resolve => { finish = resolve; });
  const connection = new SessionConnection(client, "a");
  const states = [];
  connection.subscribe(state => states.push(state));
  const sending = connection.submit("continue\n\nline: 5");
  connection.dispose();
  const count = states.length;
  finish();
  client.reads[0].resolve({ session_id: "a", snapshot: snapshot("Late") });
  await sending;
  await setImmediate();
  assert.equal(states.length, count);
  assert.equal(client.reads.length, 1);
  assert.equal(client.reads[0].signal.aborted, true);
});

test("one subscriber can detach without disconnecting the remaining view", async t => {
  const client = backend();
  const connection = new SessionConnection(client, "a");
  t.after(() => connection.dispose());
  const first = connection.subscribe(() => {});
  const received = [];
  const second = connection.subscribe(state => received.push(state));
  first.dispose();
  assert.equal(client.reads[0].signal.aborted, false);
  client.reads[0].resolve({ session_id: "a", snapshot: snapshot("Live") });
  await setImmediate();
  assert.equal(received.at(-1).snapshot.title, "Live");
  const polling = connection.refresh();
  second.dispose();
  assert.equal(client.reads[1].signal.aborted, true);
  client.reads[1].resolve({ session_id: "a", snapshot: snapshot("Detached") });
  await polling;
  assert.equal(connection.state.snapshot.title, "Live");
});

test("unexpected session identity and transport errors require an explicit refresh", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = backend();
  const connection = new SessionConnection(client, "a");
  t.after(() => connection.dispose());
  connection.subscribe(() => {});
  client.reads[0].resolve({ session_id: "wrong", snapshot: snapshot("Wrong") });
  await setImmediate();
  assert.match(connection.state.error, /different session/);
  assert.equal(connection.state.snapshot, undefined);
  t.mock.timers.tick(10_000);
  assert.equal(client.reads.length, 1);
  const refreshing = connection.refresh();
  client.reads[1].resolve({ session_id: "a", snapshot: snapshot("Reconnected") });
  await refreshing;
  assert.equal(connection.state.error, undefined);
  assert.equal(connection.state.snapshot.title, "Reconnected");
});

test("question cancellation uses the displayed request id and session", async t => {
  const client = backend();
  const connection = new SessionConnection(client, "a");
  t.after(() => connection.dispose());
  connection.subscribe(() => {});
  client.reads[0].resolve({
    session_id: "a",
    snapshot: { ...snapshot("Question"), input_request: { request_id: "r", text: "Choose" } },
  });
  await setImmediate();
  const cancelling = connection.cancelInput();
  await setImmediate();
  assert.deepEqual(client.writes, [{ id: "a", requestId: "r", answer: null }]);
  client.reads[1].resolve({ session_id: "a", snapshot: snapshot("Answered") });
  await cancelling;
  await assert.rejects(connection.cancelInput(), /no pending question/);
});

test("closing waits for the backend, blocks new input and stops polling until completion", async t => {
  const client = backend();
  const deleted = [];
  let finish;
  client.closeSession = id => {
    deleted.push(id);
    return new Promise(resolve => { finish = resolve; });
  };
  const connection = new SessionConnection(client, "a");
  t.after(() => connection.dispose());
  connection.subscribe(() => {});
  client.reads[0].resolve({ session_id: "a", snapshot: snapshot("Running") });
  await setImmediate();
  let finished = false;
  const closing = connection.close().then(() => { finished = true; });
  assert.equal(connection.state.closing, true);
  await connection.refresh();
  await assert.rejects(connection.submit("too late"), /Session is closing/);
  assert.equal(client.reads.length, 1);
  assert.equal(finished, false);
  assert.deepEqual(deleted, ["a"]);
  finish({ ok: true });
  await closing;
  assert.equal(finished, true);
  await assert.rejects(connection.submit("closed"), /disposed/);
});
