// Run manually: node packages/pycodex-ws/tests/workspace_runtime_info.mjs
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source = readFileSync(new URL("../workspace_server/workspace.html", import.meta.url), "utf8");
const functions = source.slice(
  source.indexOf("    async function fillRuntimeInfo("),
  source.indexOf("    async function submitPrompt("),
);

await new Function("assert", `
return (async () => {
  let activeSessionId = "a";
  const states = new Map([
    ["a", {}],
    ["b", {}],
    ["", {}],
  ]);
  const stateForSession = id => states.get(id);
  const relativeUrl = path => path;
  const notices = [];
  const showToast = text => notices.push(text);
  const closeContextBlock = () => {};
  const Composer = {size: parts => parts.reduce((size, part) => size + part.text.length, 0)};
  let draft = "unfinished draft";
  const composer = {
    parts: () => [{type: "text", text: draft}],
    replace(start, end, parts) {
      assert.equal(start, draft.length);
      assert.equal(end, start);
      draft += parts.map(part => part.text).join("");
    },
  };
  const requests = [];
  let resolve;
  const fetch = async (url, options) => {
    requests.push({url, options});
    return new Promise(done => {resolve = done;});
  };
  ${functions}
  const pending = fillRuntimeInfo();
  assert.equal(states.get("a").runtimeInfoLoading, true);
  await fillRuntimeInfo();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    url: "api/session?session_id=a&runtime_info=true", options: {cache: "no-store"},
  });
  draft += " typed during request";
  resolve({ok: true, json: async () => ({runtime_info: "runtime information"})});
  await pending;
  assert.equal(draft, "unfinished draft typed during request\\n\\nruntime information");
  assert.equal(states.get("a").runtimeInfoLoading, false);
  assert.equal(notices.length, 1);

  const old = fillRuntimeInfo();
  activeSessionId = "b";
  draft = "other session";
  resolve({ok: true, json: async () => ({runtime_info: "old session information"})});
  await old;
  assert.equal(draft, "other session");
  assert.equal(notices.length, 1);
  assert.equal(states.get("a").runtimeInfoLoading, false);
  // Errors leave the draft intact and allow another double-click.
  const failed = fillRuntimeInfo();
  resolve({ok: false, status: 400, json: async () => ({detail: "session closing"})});
  await failed;
  assert.match(notices[1], /session closing/);
  assert.equal(draft, "other session");
  assert.equal(states.get("b").runtimeInfoLoading, false);
  activeSessionId = "";
  await fillRuntimeInfo();
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => !request.options.method));
})();
`)(assert);
console.log("Runtime information UI checks passed.");
