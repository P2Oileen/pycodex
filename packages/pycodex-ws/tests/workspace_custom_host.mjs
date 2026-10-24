// Run manually: node packages/pycodex-ws/tests/workspace_custom_host.mjs
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source = readFileSync(new URL("../workspace_server/workspace.html", import.meta.url), "utf8");
const initialize = source.slice(
  source.indexOf("    async function mountCustomFrontend("),
  source.indexOf("\n    startContentViews();", source.indexOf("    async function mountCustomFrontend(")),
);
const moduleUrl = "data:text/javascript," + encodeURIComponent(
  "export let host; export function mount(value) { host = value; }",
);
const extension = await import(moduleUrl);
let activeSession = "first";
let draft = {parts: [{type: "text", text: "original"}]};
const state = {};
const events = new EventTarget();
const opened = [];
const run = new Function(
  "document", "getSession", "sessionById", "selectSession", "frontendEvents",
  "composer", "stateForSession", "resizePrompt", "contentTabs", "relativeUrl", "fetch",
  `${initialize.replaceAll("activeSessionId", "getSession()")}\nreturn mountCustomFrontend();`,
);
await run(
  {querySelector: () => ({src: moduleUrl})},
  () => activeSession,
  id => ["first", "second"].includes(id),
  async id => { activeSession = id; },
  events,
  {read: () => draft, set: value => { draft = value; }},
  () => state, () => {},
  {open: async (...args) => { opened.push(args); }},
  path => "/w/test/" + path,
  async path => ({ok: true, json: async () => ({path})}),
);
const host = extension.host;
assert.equal(host.apiVersion, 1);
assert.equal(host.getActiveSessionId(), "first");
assert(Object.isFrozen(host));
await host.selectSession("second");
assert.equal(host.getActiveSessionId(), "second");
await assert.rejects(host.selectSession("missing"), /Unknown session/);
const seen = [];
const unsubscribe = host.onSessionChanged(id => seen.push(id));
const changed = new Event("sessionchange");
changed.detail = "second";
events.dispatchEvent(changed);
unsubscribe();
events.dispatchEvent(changed);
assert.deepEqual(seen, ["second"]);
host.setDraft({parts: [{type: "text", text: "edited"}]});
assert.equal(host.getDraft().parts[0].text, "edited");
assert.deepEqual(state.draft, host.getDraft());
assert.throws(() => host.setDraft({}), /parts/);
await host.openView("app.py", "src");
assert.deepEqual(opened, [["app.py", "src", "second"]]);
assert.deepEqual(await host.request("api/sessions"), {path: "/w/test/api/sessions"});
console.log("Custom frontend host contract passed.");
